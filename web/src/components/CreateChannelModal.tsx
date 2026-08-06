// CreateChannelModal: name input + DM checkbox + friend picker.
// Phase 08b.
//
// The modal handles a tiny form lifecycle. On submit it validates
// shape (name non-empty; DM requires exactly 1 selected friend) and
// passes the result up to App, which fires create_channel and waits
// for the ack to decide whether to close the modal.
//
// We close the modal *here* on cancel/escape but rely on App to close
// on successful create (via dispatch close_create_modal in
// handleFrame).

import { useEffect, useState } from "preact/hooks";
import type { Friend } from "../state/types";
import { FriendPicker } from "./FriendPicker";
import { DEFAULT_GROUP, canonicalizeGroup } from "../chat/channel-groups";

interface Props {
  friends: Friend[];
  loading: boolean;
  // 30-6: server feature flag. When false the voice option is hidden --
  // the server would reject the join anyway (CHALK_VOICE_ENABLED).
  voiceEnabled: boolean;
  // 54-2: group names already in the roster. 54-5: they are the picker's
  // options, so reusing one is the default and minting a near-duplicate
  // takes a deliberate step.
  knownGroups: string[];
  onClose: () => void;
  // 80-12: server feature flag for ephemeral channels; hides the TTL option
  // when the server would refuse it.
  ephemeralEnabled: boolean;
  // 30-4: voice=true creates a Discord-style voice room (channel_type=
  // 'voice'). isDM is always passed false: 1:1 channels are opened from the
  // friends roster (which activates the existing DM), not created here. The
  // param is kept so the App-level wire mapping stays unchanged.
  // 54-2: group is the canonicalized grouping suggestion, never empty.
  // 80-12: ttlSecs > 0 makes the voice room ephemeral (0 = permanent).
  onSubmit: (name: string, isDM: boolean, memberIDs: string[], voice: boolean, group: string, ttlSecs: number) => void;
}

// 54-5: the <option> value that reveals the new-group input. Leading and
// trailing space is trimmed off every real group name, so a lone space can
// never collide with one.
const NEW_GROUP_OPTION = " ";

// 80-12: the ephemeral lifetime choices. The server clamps to its own cap
// (default one month), so the menu only offers values under it.
const TTL_CHOICES: Array<{ label: string; secs: number }> = [
  { label: "never (permanent)", secs: 0 },
  { label: "1 hour", secs: 3600 },
  { label: "4 hours", secs: 4 * 3600 },
  { label: "24 hours", secs: 24 * 3600 },
  { label: "7 days", secs: 7 * 24 * 3600 },
  { label: "30 days", secs: 30 * 24 * 3600 },
];

export function CreateChannelModal({ friends, loading, voiceEnabled, ephemeralEnabled, knownGroups, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  // 54-5: the picked group, or NEW_GROUP_OPTION while naming a new one.
  const [group, setGroup] = useState(knownGroups[0] ?? DEFAULT_GROUP);
  const [newGroup, setNewGroup] = useState("");
  const [voice, setVoice] = useState(false); // 30-4
  const [ttlSecs, setTtlSecs] = useState(0); // 80-12; 0 = permanent
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const namingNewGroup = group === NEW_GROUP_OPTION;

  // Escape to close.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const submit = (e: Event) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("name required");
      return;
    }
    if (trimmed.length > 80) {
      setError("name too long (max 80)");
      return;
    }
    // Falling back to the default group here would silently ignore the
    // deliberate "new group" pick, so say so instead.
    if (namingNewGroup && !newGroup.trim()) {
      setError("new group name required");
      return;
    }
    if (newGroup.trim().length > 80) {
      setError("group too long (max 80)");
      return;
    }
    if (selected.size < 1) {
      setError("pick at least one member");
      return;
    }
    // is_dm is always false here: a 1:1 is created by clicking a friend in
    // the roster (which opens the EXISTING DM), never from this modal. A
    // second DM between the same pair would strand the first one's history.
    onSubmit(trimmed, false, Array.from(selected), voice,
      canonicalizeGroup(namingNewGroup ? newGroup : group, knownGroups),
      voice ? ttlSecs : 0);
  };

  return (
    <div class="chalk-modal-backdrop" onClick={onClose} data-testid="create-modal">
      <div
        class="chalk-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="create-modal-title"
      >
        <header class="chalk-modal-header">
          <h2 id="create-modal-title">new channel</h2>
          <button
            class="chalk-modal-close"
            type="button"
            onClick={onClose}
            aria-label="close"
            data-testid="create-modal-close"
          >
            ×
          </button>
        </header>

        <div class="chalk-modal-body">
          <label class="chalk-field">
            <span class="chalk-field-label">name</span>
            <input
              type="text"
              class="chalk-field-input"
              data-testid="create-modal-name"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              autoFocus
              maxLength={80}
              placeholder="general"
            />
          </label>

          {/* 54-2/54-5: the grouping suggestion. The groups already in the
              roster are the options and one of them is preselected, so the
              cheap path is reuse; a new group is an explicit pick that
              reveals a name field. (54-2 offered free text with a datalist
              of the same names, which read as a plain text box -- the
              existing groups only surfaced in an unstyled native popup, and
              typing past them forked "General"/"general".) Submit still
              canonicalizes case against knownGroups. */}
          <div class="chalk-field">
            <span class="chalk-field-label">group</span>
            <select
              class="chalk-field-input"
              data-testid="create-modal-group"
              value={group}
              onChange={(e) => setGroup((e.target as HTMLSelectElement).value)}
              aria-label="group"
            >
              {knownGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              <option value={NEW_GROUP_OPTION}>+ new group…</option>
            </select>
            {namingNewGroup && (
              <input
                type="text"
                class="chalk-field-input"
                data-testid="create-modal-group-new"
                value={newGroup}
                onInput={(e) => setNewGroup((e.target as HTMLInputElement).value)}
                autoFocus
                maxLength={80}
                placeholder="new group name"
                aria-label="new group name"
              />
            )}
          </div>

          {voiceEnabled && (
            <label class="chalk-field chalk-field--checkbox">
              <input
                type="checkbox"
                data-testid="create-modal-voice"
                checked={voice}
                onChange={(e) => setVoice((e.target as HTMLInputElement).checked)}
              />
              <span>voice channel (live audio/video room)</span>
            </label>
          )}

          {/* 80-12: only a voice room can be ephemeral (guests join a call,
              not an archive), so the lifetime picker appears with the voice
              checkbox and resets to permanent when it's unchecked. */}
          {voiceEnabled && ephemeralEnabled && voice && (
            <label class="chalk-field">
              <span class="chalk-field-label">disappears after</span>
              <select
                class="chalk-field-input"
                data-testid="create-modal-ttl"
                value={String(ttlSecs)}
                onChange={(e) => setTtlSecs(Number((e.target as HTMLSelectElement).value))}
              >
                {TTL_CHOICES.map((c) => (
                  <option key={c.secs} value={String(c.secs)}>
                    {c.label}
                  </option>
                ))}
              </select>
              {ttlSecs > 0 && (
                <div class="chalk-field-hint">
                  the room, its messages and its guest links are destroyed when
                  the timer runs out — for everyone, permanently.
                </div>
              )}
            </label>
          )}

          <div class="chalk-field">
            <span class="chalk-field-label">members</span>
            {loading ? (
              <div class="chalk-field-hint" data-testid="create-modal-friends-loading">
                loading friends...
              </div>
            ) : friends.length === 0 ? (
              <div class="chalk-field-hint" data-testid="create-modal-no-friends">
                no friends yet. add some first (not yet supported).
              </div>
            ) : (
              <FriendPicker
                friends={friends}
                selected={selected}
                singleSelect={false}
                onChange={setSelected}
              />
            )}
          </div>

          {error && (
            <div class="chalk-modal-error" data-testid="create-modal-error">
              {error}
            </div>
          )}
        </div>

        <footer class="chalk-modal-footer">
          <button
            type="button"
            class="chalk-button chalk-button--secondary"
            onClick={onClose}
            data-testid="create-modal-cancel"
          >
            cancel
          </button>
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            onClick={submit}
            disabled={loading || friends.length === 0}
            data-testid="create-modal-submit"
          >
            create
          </button>
        </footer>
      </div>
    </div>
  );
}
