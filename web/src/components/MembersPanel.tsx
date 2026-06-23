// MembersPanel: in-chat overlay showing the active channel's members, each
// member's encryption-key status, and per-member out-of-band identity
// verification. Phases 23e (key status) + 24b (verification).
//
// Opened from the encryption lock in the channel header. Same overlay pattern
// as FriendsPanel/InvitesPanel: fixed card, click-outside + Escape to close.
//
// KEY STATUS (two truthful states):
//   * "has key" -- a wrapped channel key exists for that member.
//   * "waiting" -- no wrap exists for them yet.
//
// VERIFICATION (per member; 24b): a badge shows whether you've verified this
// member's identity out of band -- unverified / verified / changed (their key
// differs from what you verified) / no identity (they haven't published one).
// Click a member to open the verify view: a single shared safety number (8
// words by default, a 60-digit numeric on toggle) that BOTH of you compute
// identically. Compare it over a trusted channel (in person, a call); if it
// matches, mark verified (with an explicit confirm). A "changed" member must
// be re-verified.
//
// Presentational: App owns the crypto, fetches recipients + computes each
// member's safety number / verification state, and passes them in.

import { useEffect, useState } from "preact/hooks";
import type { ChannelMember } from "../state/types";
import type { VerificationState } from "../crypto/safety-number";

export type MemberVerifyState = VerificationState | "no_identity";

export interface MemberVerifyInfo {
  state: MemberVerifyState;
  words?: string[]; // absent for no_identity
  numeric?: string;
}

interface Props {
  channelName: string;
  members: ChannelMember[];
  recipients: Set<string>;
  ownUserID: string | null;
  weHoldKey: boolean;
  loading: boolean;
  resharing: boolean;
  // Phase 25-2: rotation (creator-only).
  isCreator: boolean;
  currentKeyVersion: number;
  rotating: boolean;
  // member removal
  rotationPending: boolean;
  isDM: boolean;
  onRemoveMember: (userID: string) => void;
  // per-member verification (keyed by userID); 24b
  verification: Record<string, MemberVerifyInfo>;
  verificationLoading: boolean;
  onMarkVerified: (userID: string) => void;
  onReshare: () => void;
  onRotate: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

function verifyBadgeText(s: MemberVerifyState): string {
  switch (s) {
    case "verified": return "verified";
    case "changed": return "key changed";
    case "no_identity": return "no identity";
    default: return "unverified";
  }
}

export function MembersPanel({
  channelName,
  members,
  recipients,
  ownUserID,
  weHoldKey,
  loading,
  resharing,
  isCreator,
  currentKeyVersion,
  rotating,
  rotationPending,
  isDM,
  onRemoveMember,
  verification,
  verificationLoading,
  onMarkVerified,
  onReshare,
  onRotate,
  onRefresh,
  onClose,
}: Props) {
  // which member's verify view is open (null = the list)
  const [selected, setSelected] = useState<string | null>(null);
  // verify-view local UI: numeric toggle + the inline confirm step
  const [showNumeric, setShowNumeric] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selected) setSelected(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, selected]);

  // reset verify-view sub-state whenever the selected member changes
  useEffect(() => {
    setShowNumeric(false);
    setConfirming(false);
  }, [selected]);

  const sorted = [...members].sort((a, b) => a.handle.localeCompare(b.handle));
  const waitingCount = members.filter((m) => !recipients.has(m.userID)).length;

  const selectedMember = selected ? members.find((m) => m.userID === selected) : undefined;
  const selectedInfo = selected ? verification[selected] : undefined;

  return (
    <div class="chalk-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        class="chalk-modal-card chalk-members-panel"
        role="dialog"
        aria-label="channel members, encryption status, and verification"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="chalk-members-header">
          <div class="chalk-members-title">
            {selectedMember ? (
              <button
                type="button"
                class="chalk-members-back"
                onClick={() => setSelected(null)}
                aria-label="back to members"
              >
                &lt; verify
              </button>
            ) : (
              <>members <span class="chalk-members-chan">{channelName}</span></>
            )}
          </div>
          <div class="chalk-members-header-actions">
            {!selectedMember && (
              <button
                type="button"
                class="chalk-members-refresh"
                onClick={onRefresh}
                disabled={loading}
                aria-label="refresh status"
                title="refresh status"
              >
                refresh
              </button>
            )}
            <button
              type="button"
              class="chalk-modal-close"
              onClick={onClose}
              aria-label="close"
            >
              x
            </button>
          </div>
        </div>

        {selectedMember ? (
          <VerifyView
            member={selectedMember}
            info={selectedInfo}
            showNumeric={showNumeric}
            onToggleNumeric={() => setShowNumeric((v) => !v)}
            confirming={confirming}
            onStartConfirm={() => setConfirming(true)}
            onCancelConfirm={() => setConfirming(false)}
            onConfirmVerified={() => {
              onMarkVerified(selectedMember.userID);
              setConfirming(false);
            }}
          />
        ) : (
          <>
            <div class="chalk-members-body">
              {loading ? (
                <div class="chalk-members-empty">checking key status...</div>
              ) : sorted.length === 0 ? (
                <div class="chalk-members-empty">no members</div>
              ) : (
                <ul class="chalk-members-list">
                  {sorted.map((m) => {
                    const hasKey = recipients.has(m.userID);
                    const isYou = ownUserID != null && m.userID === ownUserID;
                    const vinfo = verification[m.userID];
                    const vstate = vinfo?.state ?? "unverified";
                    return (
                      <li key={m.userID} class="chalk-members-row">
                        <span class="chalk-members-handle">
                          {m.handle}
                          {isYou && <span class="chalk-members-you"> (you)</span>}
                        </span>
                        <span class="chalk-members-badges">
                          {!isYou && (
                            <button
                              type="button"
                              class={
                                "chalk-verify-badge chalk-verify-badge--" +
                                (vstate === "verified"
                                  ? "verified"
                                  : vstate === "changed"
                                    ? "changed"
                                    : vstate === "no_identity"
                                      ? "none"
                                      : "unverified")
                              }
                              onClick={() => setSelected(m.userID)}
                              disabled={vstate === "no_identity" || verificationLoading}
                              title="view safety number / verify identity"
                            >
                              {verificationLoading ? "..." : verifyBadgeText(vstate)}
                            </button>
                          )}
                          <span
                            class={
                              "chalk-members-status " +
                              (hasKey
                                ? "chalk-members-status--has"
                                : "chalk-members-status--waiting")
                            }
                            title={
                              hasKey
                                ? "a wrapped key exists for this member"
                                : "no key wrapped for this member yet"
                            }
                          >
                            {hasKey ? "has key" : "waiting"}
                          </span>
                          {/* Member removal: owner can remove non-owner members
                              (not on DMs, not the owner row). */}
                          {isCreator && !isDM && !isYou && (
                            <button
                              type="button"
                              class="chalk-members-remove"
                              onClick={() => onRemoveMember(m.userID)}
                              title="remove this member from the channel"
                              aria-label="remove member"
                            >
                              ✕
                            </button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div class="chalk-members-footer">
              {weHoldKey ? (
                waitingCount > 0 ? (
                  <button
                    type="button"
                    class="chalk-members-reshare"
                    onClick={onReshare}
                    disabled={resharing}
                  >
                    {resharing
                      ? "re-sharing..."
                      : `re-share key to ${waitingCount} waiting member${waitingCount === 1 ? "" : "s"}`}
                  </button>
                ) : (
                  <span class="chalk-members-allset">all members have the key</span>
                )
              ) : (
                <span class="chalk-members-nokey">
                  you don't hold this channel's key yet
                </span>
              )}
              {isCreator && (
                <div class="chalk-members-rotate-row">
                  <button
                    type="button"
                    class="chalk-members-rotate"
                    onClick={onRotate}
                    disabled={rotating || !weHoldKey}
                    title={
                      weHoldKey
                        ? "mint a new channel key for the current members"
                        : "you need the current key before you can rotate"
                    }
                  >
                    {rotating ? "rotating..." : "rotate channel key"}
                  </button>
                  <span class="chalk-members-keyver">key v{currentKeyVersion}</span>
                </div>
              )}
              {rotationPending && (
                <div class="chalk-members-pending" title="a member was removed; the channel key is being rotated so they lose access to new messages">
                  {rotating
                    ? "rotating key..."
                    : isCreator
                      ? "key rotation pending"
                      : "key rotation pending (owner will rotate)"}
                </div>
              )}
              {!isDM && (
                <button
                  type="button"
                  class="chalk-members-leave"
                  onClick={() => ownUserID && onRemoveMember(ownUserID)}
                  disabled={isCreator}
                  title={
                    isCreator
                      ? "the owner can't leave their own channel"
                      : "leave this channel"
                  }
                >
                  leave channel
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function VerifyView({
  member,
  info,
  showNumeric,
  onToggleNumeric,
  confirming,
  onStartConfirm,
  onCancelConfirm,
  onConfirmVerified,
}: {
  member: ChannelMember;
  info: MemberVerifyInfo | undefined;
  showNumeric: boolean;
  onToggleNumeric: () => void;
  confirming: boolean;
  onStartConfirm: () => void;
  onCancelConfirm: () => void;
  onConfirmVerified: () => void;
}) {
  if (!info || info.state === "no_identity" || !info.words || !info.numeric) {
    return (
      <div class="chalk-verify-view">
        <div class="chalk-verify-empty">
          {member.handle} hasn't published an identity yet, so there's nothing to
          verify.
        </div>
      </div>
    );
  }

  const verified = info.state === "verified";
  const changed = info.state === "changed";

  return (
    <div class="chalk-verify-view">
      <div class="chalk-verify-intro">
        Compare this safety number with {member.handle} over a trusted channel
        (in person or a call). You should both see the same code. If it matches,
        mark them verified.
      </div>

      {changed && (
        <div class="chalk-verify-warn">
          {member.handle}'s identity key has changed since you last verified
          them. Only re-verify after confirming the new code out of band.
        </div>
      )}

      <div class="chalk-verify-code">
        {showNumeric ? (
          <div class="chalk-verify-numeric">{info.numeric}</div>
        ) : (
          <div class="chalk-verify-words">
            {info.words.map((w, i) => (
              <span key={i} class="chalk-verify-word">
                {w}
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        class="chalk-verify-toggle"
        onClick={onToggleNumeric}
      >
        {showNumeric ? "show words" : "show numeric"}
      </button>

      <div class="chalk-verify-actions">
        {verified ? (
          <div class="chalk-verify-state chalk-verify-state--verified">
            verified &#10003;
          </div>
        ) : confirming ? (
          <div class="chalk-verify-confirm">
            <div class="chalk-verify-confirm-text">
              I compared this code with {member.handle} out of band and it
              matches.
            </div>
            <div class="chalk-verify-confirm-buttons">
              <button
                type="button"
                class="chalk-verify-confirm-yes"
                onClick={onConfirmVerified}
              >
                confirm
              </button>
              <button
                type="button"
                class="chalk-verify-confirm-no"
                onClick={onCancelConfirm}
              >
                cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            class="chalk-verify-mark"
            onClick={onStartConfirm}
          >
            {changed ? "re-verify" : "mark as verified"}
          </button>
        )}
      </div>
    </div>
  );
}
