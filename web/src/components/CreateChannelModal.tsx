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
  onClose: () => void;
  // 30-4: voice=true creates a Discord-style voice room (channel_type=
  // 'voice'). Mutually exclusive with DM (the server rejects voice DMs).
  onSubmit: (name: string, isDM: boolean, memberIDs: string[], voice: boolean) => void;
}

export function CreateChannelModal({ friends, loading, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [isDM, setIsDM] = useState(false);
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
    if (isDM && selected.size !== 1) {
      setError("DM needs exactly one other member");
      return;
    }
    if (!isDM && selected.size < 1) {
      setError("pick at least one member");
      return;
    }
    onSubmit(trimmed, isDM, Array.from(selected), !isDM && voice);
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

          <label class="chalk-field chalk-field--checkbox">
            <input
              type="checkbox"
              data-testid="create-modal-dm"
              checked={isDM}
              onChange={(e) => {
                const v = (e.target as HTMLInputElement).checked;
                setIsDM(v);
                if (v && selected.size > 1) {
                  // DM allows exactly one; trim to one.
                  setSelected(new Set([Array.from(selected)[0]!]));
                }
              }}
            />
            <span>direct message (1:1)</span>
          </label>

          {!isDM && (
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
                singleSelect={isDM}
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
