// chalk 116-2 -- the what's-new note.
//
// The AvatarNudge shape (112-6) with one difference that is the whole
// design: closing it is not answering it. A person who shuts the note has
// not read it, and it comes back on their next load; ticking "read" is the
// answer, and that is what writes the account pref. Nobody is forced to
// tick -- the close button always works -- and nobody has the note quietly
// filed as read by a stray click on the backdrop.
//
// Reopened from settings → about, it shows every note it carries, with the
// tick reflecting the stored mark.

import type { WhatsNewEntry } from "../whats-new";

interface Props {
  entries: WhatsNewEntry[];
  /** the stored read mark already covers every entry shown */
  read: boolean;
  /** the tick: mark everything shown as read (or, unticked, forget the mark) */
  onRead: (read: boolean) => void;
  onClose: () => void;
}

export function WhatsNewNudge({ entries, read, onRead, onClose }: Props) {
  return (
    <div
      class="chalk-modal-backdrop"
      data-testid="whats-new-backdrop"
      onClick={(e) => {
        // Clicking away closes for now. It does not count as having read
        // anything -- only the tick does.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        class="chalk-modal chalk-whats-new"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        data-testid="whats-new"
      >
        <header class="chalk-modal-header">
          <h2 id="whats-new-title">what's new</h2>
          <button
            type="button"
            class="chalk-modal-close"
            aria-label="close"
            data-testid="whats-new-close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div class="chalk-modal-body">
          {entries.length === 0 && (
            <p class="chalk-profile-hint">nothing new since you last looked.</p>
          )}
          {entries.map((e) => (
            <section key={e.phase} class="chalk-whats-new-entry" data-testid="whats-new-entry">
              <h3>{e.title}</h3>
              <ul>
                {e.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {e.where && <p class="chalk-profile-hint">{e.where}</p>}
            </section>
          ))}
        </div>
        <footer class="chalk-modal-footer chalk-whats-new-footer">
          <label class="chalk-profile-checkbox-label">
            <input
              type="checkbox"
              checked={read}
              onChange={(e) => onRead((e.target as HTMLInputElement).checked)}
              data-testid="whats-new-read"
            />
            <span>I've read this — don't show it again</span>
          </label>
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            data-testid="whats-new-dismiss"
            onClick={onClose}
          >
            close
          </button>
        </footer>
      </div>
    </div>
  );
}
