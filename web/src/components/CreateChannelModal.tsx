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

interface Props {
  friends: Friend[];
  loading: boolean;
  // 30-6: server feature flag. When false the voice option is hidden --
  // the server would reject the join anyway (CHALK_VOICE_ENABLED).
  voiceEnabled: boolean;
  onClose: () => void;
  // 30-4: voice=true creates a Discord-style voice room (channel_type=
  // 'voice'). isDM is always passed false: 1:1 channels are opened from the
  // friends roster (which activates the existing DM), not created here. The
  // param is kept so the App-level wire mapping stays unchanged.
  onSubmit: (name: string, isDM: boolean, memberIDs: string[], voice: boolean) => void;
}

export function CreateChannelModal({ friends, loading, voiceEnabled, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [voice, setVoice] = useState(false); // 30-4
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

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
    if (selected.size < 1) {
      setError("pick at least one member");
      return;
    }
    // is_dm is always false here: a 1:1 is created by clicking a friend in
    // the roster (which opens the EXISTING DM), never from this modal. A
    // second DM between the same pair would strand the first one's history.
    onSubmit(trimmed, false, Array.from(selected), voice);
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
