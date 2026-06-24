// GovernancePanel: in-chat overlay for a channel's governance (gov-2-2).
//
// Opened from the mode badge in the channel header. Same overlay pattern as
// MembersPanel (fixed card, click-outside + Escape to close). Presentational:
// App owns the WS send-paths and passes the channel's proposals + mode +
// callbacks; live tally updates arrive via governance_event pushes that the
// reducer folds into app state, so this panel just renders what it's given.
//
//   dictator mode:
//     - owner sees "Go democratic" (unilateral; the owner cedes power).
//   democratic mode:
//     - anyone can open a remove_member / add_member proposal.
//     - anyone can open a "return to dictator" proposal (supermajority;
//       reverts ownership to the original creator).
//     - proposals list: live tally, vote yes/no, cancel (author or owner).

import { useEffect, useState } from "preact/hooks";
import type { ChannelMember, Friend, ProposalView } from "../state/types";

interface Props {
  channelName: string;
  mode: string;
  isOwner: boolean;
  ownUserID: string | null;
  createdBy: string;
  members: ChannelMember[];
  addableFriends: Friend[];
  proposals: ProposalView[];
  loading: boolean;
  onSetMode: (mode: string) => Promise<void>;
  onProposeDictator: () => Promise<void>;
  onPropose: (type: string, targetID: string) => Promise<void>;
  onVote: (proposalID: string, vote: "yes" | "no") => Promise<void>;
  onCancel: (proposalID: string) => Promise<void>;
  onRefresh: () => void;
  onClose: () => void;
}

function typeLabel(t: string): string {
  switch (t) {
    case "remove_member": return "remove member";
    case "add_member": return "add member";
    case "set_mode": return "return to dictator";
    case "delete_message": return "delete message";
    default: return t;
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case "open": return "open";
    case "passed": return "passed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "passed_moot": return "passed (no effect)";
    default: return s;
  }
}

export function GovernancePanel({
  channelName,
  mode,
  isOwner,
  ownUserID,
  createdBy,
  members,
  addableFriends,
  proposals,
  loading,
  onSetMode,
  onProposeDictator,
  onPropose,
  onVote,
  onCancel,
  onRefresh,
  onClose,
}: Props) {
  const democratic = mode === "democratic";

  // propose-form local state
  const [proposeType, setProposeType] = useState<"remove_member" | "add_member">("remove_member");
  const [proposeTarget, setProposeTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // reset the target when the proposal type flips
  useEffect(() => {
    setProposeTarget("");
  }, [proposeType]);

  const handleOf = (id: string): string => {
    const m = members.find((x) => x.userID === id);
    if (m && m.handle) return m.handle;
    const f = addableFriends.find((x) => x.userID === id);
    if (f && f.handle) return f.handle;
    return id.slice(0, 8);
  };

  const removeTargets = members.filter((m) => m.userID !== createdBy);
  const targetOptions =
    proposeType === "remove_member"
      ? removeTargets.map((m) => ({ id: m.userID, label: m.handle || m.userID.slice(0, 8) }))
      : addableFriends.map((f) => ({ id: f.userID, label: f.handle || f.userID.slice(0, 8) }));

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitPropose = () => {
    if (!proposeTarget) return;
    void wrap(async () => {
      await onPropose(proposeType, proposeTarget);
      setProposeTarget("");
    });
  };

  const open = proposals.filter((p) => p.status === "open");
  const resolved = proposals.filter((p) => p.status !== "open");

  return (
    <div class="chalk-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        class="chalk-modal-card chalk-gov-panel"
        role="dialog"
        aria-label="channel governance"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="chalk-members-header">
          <div class="chalk-members-title">
            governance <span class="chalk-members-chan">{channelName}</span>
          </div>
          <div class="chalk-members-header-actions">
            <button
              type="button"
              class="chalk-members-refresh"
              onClick={onRefresh}
              disabled={loading}
              title="refresh proposals"
            >
              refresh
            </button>
            <button type="button" class="chalk-modal-close" onClick={onClose} aria-label="close">
              x
            </button>
          </div>
        </div>

        <div class="chalk-members-body">
          {/* mode + controls */}
          <div class="chalk-gov-mode">
            <span class="chalk-gov-mode-label">
              mode: <strong>{democratic ? "democratic" : "dictator"}</strong>
            </span>
            {!democratic && isOwner && (
              <button
                type="button"
                class="chalk-btn"
                disabled={busy}
                onClick={() => void wrap(() => onSetMode("democratic"))}
              >
                go democratic
              </button>
            )}
            {democratic && (
              <button
                type="button"
                class="chalk-btn"
                disabled={busy}
                title="propose returning the channel to dictator (supermajority)"
                onClick={() => void wrap(onProposeDictator)}
              >
                propose return to dictator
              </button>
            )}
          </div>

          {!democratic && (
            <p class="chalk-gov-hint">
              In dictator mode the owner acts unilaterally. Switch to democratic to decide
              member changes by vote.
            </p>
          )}

          {/* propose form (democratic only) */}
          {democratic && (
            <div class="chalk-gov-propose">
              <div class="chalk-gov-propose-row">
                <select
                  class="chalk-select"
                  value={proposeType}
                  disabled={busy}
                  onChange={(e) =>
                    setProposeType((e.currentTarget.value as "remove_member" | "add_member"))
                  }
                  aria-label="proposal type"
                >
                  <option value="remove_member">remove member</option>
                  <option value="add_member">add member</option>
                </select>
                <select
                  class="chalk-select"
                  value={proposeTarget}
                  disabled={busy || targetOptions.length === 0}
                  onChange={(e) => setProposeTarget(e.currentTarget.value)}
                  aria-label="proposal target"
                >
                  <option value="">
                    {targetOptions.length === 0 ? "(no eligible targets)" : "select target..."}
                  </option>
                  {targetOptions.map((o) => (
                    <option value={o.id}>{o.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  class="chalk-btn"
                  disabled={busy || !proposeTarget}
                  onClick={submitPropose}
                >
                  propose
                </button>
              </div>
            </div>
          )}

          {error && <div class="chalk-gov-error">{error}</div>}

          {/* proposals */}
          <div class="chalk-gov-list">
            {loading ? (
              <div class="chalk-members-empty">loading proposals...</div>
            ) : open.length === 0 && resolved.length === 0 ? (
              <div class="chalk-members-empty">no proposals</div>
            ) : (
              <>
                {open.map((p) => (
                  <ProposalRow
                    key={p.id}
                    p={p}
                    handleOf={handleOf}
                    canCancel={isOwner || p.createdBy === ownUserID}
                    busy={busy}
                    onVote={(v) => void wrap(() => onVote(p.id, v))}
                    onCancel={() => void wrap(() => onCancel(p.id))}
                  />
                ))}
                {resolved.length > 0 && (
                  <div class="chalk-gov-resolved-head">resolved</div>
                )}
                {resolved.map((p) => (
                  <ProposalRow
                    key={p.id}
                    p={p}
                    handleOf={handleOf}
                    canCancel={false}
                    busy={busy}
                    onVote={() => {}}
                    onCancel={() => {}}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProposalRow({
  p,
  handleOf,
  canCancel,
  busy,
  onVote,
  onCancel,
}: {
  p: ProposalView;
  handleOf: (id: string) => string;
  canCancel: boolean;
  busy: boolean;
  onVote: (vote: "yes" | "no") => void;
  onCancel: () => void;
}) {
  const isOpen = p.status === "open";
  const target = p.targetID ? handleOf(p.targetID) : "";
  const pct = p.eligible > 0 ? Math.round((p.voted / p.eligible) * 100) : 0;

  return (
    <div class={"chalk-gov-prop" + (isOpen ? "" : " chalk-gov-prop-resolved")}>
      <div class="chalk-gov-prop-head">
        <span class="chalk-gov-prop-type">{typeLabel(p.type)}</span>
        {target && <span class="chalk-gov-prop-target">{target}</span>}
        {!isOpen && <span class="chalk-gov-prop-status">{statusLabel(p.status)}</span>}
      </div>

      <div class="chalk-gov-tally" aria-label="tally">
        <div class="chalk-gov-tally-bar">
          <span class="chalk-gov-tally-fill" style={`width:${pct}%`} />
        </div>
        <span class="chalk-gov-tally-counts">
          yes {p.yes} &middot; no {p.no} &middot; voted {p.voted}/{p.eligible}
        </span>
      </div>

      {isOpen && (
        <div class="chalk-gov-prop-actions">
          <button
            type="button"
            class={"chalk-btn chalk-btn-sm" + (p.yourVote === "yes" ? " chalk-btn-on" : "")}
            disabled={busy}
            onClick={() => onVote("yes")}
          >
            yes
          </button>
          <button
            type="button"
            class={"chalk-btn chalk-btn-sm" + (p.yourVote === "no" ? " chalk-btn-on" : "")}
            disabled={busy}
            onClick={() => onVote("no")}
          >
            no
          </button>
          {canCancel && (
            <button
              type="button"
              class="chalk-btn chalk-btn-sm chalk-btn-danger"
              disabled={busy}
              onClick={onCancel}
            >
              cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}
