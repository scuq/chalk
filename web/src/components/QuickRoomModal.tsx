// 130-3: The quick create for a temporary room, opened from the voice section
// of the sidebar. The user types one name. The lifetime is fixed and no member
// is picked, because the other people are guests. The user invites them by
// link after the room exists. CreateChannelModal is the place for every other
// choice.

import { useEffect, useState } from "preact/hooks";

interface Props {
  /** The fixed lifetime in seconds. The dialog shows it in hours. */
  ttlSecs: number;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

export function QuickRoomModal({ ttlSecs, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const hours = Math.round(ttlSecs / 3600);

  // Escape closes the dialog. The backdrop does not close it, because a click
  // that misses the card must not remove the dialog (130-1).
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
    setError(null);
    setSubmitted(true);
    onSubmit(trimmed);
  };

  return (
    <div class="chalk-modal-backdrop" data-testid="quick-room-modal">
      <div class="chalk-modal" role="dialog" aria-labelledby="quick-room-title">
        <header class="chalk-modal-header">
          <h2 id="quick-room-title">new temporary room</h2>
          <button
            class="chalk-modal-close"
            type="button"
            onClick={onClose}
            aria-label="close"
            data-testid="quick-room-close"
          >
            ×
          </button>
        </header>

        <form class="chalk-modal-body" onSubmit={submit}>
          <label class="chalk-field">
            <span class="chalk-field-label">name</span>
            <input
              type="text"
              class="chalk-field-input"
              data-testid="quick-room-name"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              maxLength={80}
              autoFocus
              placeholder="quick call"
            />
          </label>
          <div class="chalk-field-hint">
            a voice room that disappears after {hours} hours — for everyone,
            permanently. Once it exists you can mint guest links for people
            without an account.
          </div>
          {error && (
            <div class="chalk-modal-error" data-testid="quick-room-error">
              {error}
            </div>
          )}
        </form>

        <footer class="chalk-modal-footer">
          <button
            type="button"
            class="chalk-button chalk-button--secondary"
            onClick={onClose}
            data-testid="quick-room-cancel"
          >
            cancel
          </button>
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            onClick={submit}
            disabled={submitted}
            data-testid="quick-room-submit"
          >
            {submitted ? "creating…" : "create"}
          </button>
        </footer>
      </div>
    </div>
  );
}
