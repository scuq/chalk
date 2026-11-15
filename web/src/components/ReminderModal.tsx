// ReminderModal: the dialog that sets a reminder on one message.
// Phase 87-3.
//
// Opens from the row menu item "remind me...". Shows the presets that are
// offered at this time, each with its due time, and a field for a custom time.
// The modal only chooses a time. App.tsx owns the message and the store.
//
// Props:
//   open     -- whether the modal is visible. When false, nothing renders.
//   error    -- text from the caller, for example the cap message. It keeps
//               the modal open so the user can cancel or try again.
//   onPick   -- called with the due time in epoch milliseconds.
//   onCancel -- called on cancel, escape, and click-outside.
import { useEffect, useState } from "preact/hooks";
import {
  PRESET_LABELS,
  REMINDER_PRESETS,
  dueAtFor,
  fromLocalInput,
  toLocalInput,
  type ReminderPreset,
} from "../chat/reminders";

interface Props {
  open: boolean;
  error: string | null;
  onPick: (dueAt: number) => void;
  onCancel: () => void;
}

// The time on a preset button: the short weekday and the hour and minute.
function fmtDue(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ReminderModal({ open, error, onPick, onCancel }: Props) {
  // The clock at the time the modal opened. It decides which presets are
  // offered, and it sets the `min` of the custom field.
  const [now, setNow] = useState(() => Date.now());
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  // Each time the modal opens, read the clock again and clear the old input.
  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    setCustom("");
    setCustomError(null);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  // A preset is offered only if dueAtFor gives a time for it at this clock.
  // For example, "this evening" is not offered from 18:00. The custom preset
  // has its own field.
  const presets: { preset: ReminderPreset; dueAt: number }[] = [];
  for (const preset of REMINDER_PRESETS) {
    if (preset === "custom") continue;
    const dueAt = dueAtFor(preset, now);
    if (dueAt !== null) presets.push({ preset, dueAt });
  }

  // The modal can stay open past a preset boundary. So the click reads the
  // clock again. If the preset is no longer offered, the modal refreshes its
  // list and sets nothing, so a preset never gets a wrong time.
  const pickPreset = (preset: ReminderPreset) => {
    const dueAt = dueAtFor(preset, Date.now());
    if (dueAt === null) {
      setNow(Date.now());
      return;
    }
    onPick(dueAt);
  };

  // dueAtFor returns null for a time that is not later than the clock of the
  // click. An input that fromLocalInput cannot read becomes NaN, so it fails
  // the same way.
  const pickCustom = () => {
    const dueAt = dueAtFor("custom", Date.now(), fromLocalInput(custom) ?? Number.NaN);
    if (dueAt === null) {
      setCustomError("pick a time in the future.");
      return;
    }
    onPick(dueAt);
  };

  // The error of the caller comes before the error of the custom field.
  const shownError = error ?? customError;

  return (
    <div
      class="chalk-modal-backdrop"
      data-testid="reminder-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        class="chalk-modal chalk-modal--reminder"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reminder-modal-title"
        data-testid="reminder-modal"
      >
        <header class="chalk-modal-header">
          <h2 id="reminder-modal-title">remind me about this message</h2>
        </header>
        <div class="chalk-modal-body">
          <div class="chalk-reminder-presets">
            {presets.map(({ preset, dueAt }) => (
              <button
                key={preset}
                type="button"
                class="chalk-button chalk-reminder-preset"
                onClick={() => pickPreset(preset)}
                data-testid={`reminder-preset-${preset}`}
              >
                <span>{PRESET_LABELS[preset]}</span>
                <span class="chalk-reminder-preset-when">{fmtDue(dueAt)}</span>
              </button>
            ))}
          </div>
          <div class="chalk-reminder-custom">
            <label class="chalk-field">
              <span class="chalk-field-label">{PRESET_LABELS.custom}</span>
              <input
                type="datetime-local"
                class="chalk-field-input"
                min={toLocalInput(now)}
                value={custom}
                onInput={(e) => {
                  setCustom((e.target as HTMLInputElement).value);
                  setCustomError(null);
                }}
                data-testid="reminder-custom-input"
              />
            </label>
            <button
              type="button"
              class="chalk-button chalk-button--primary"
              disabled={custom === ""}
              onClick={pickCustom}
              data-testid="reminder-custom-set"
            >
              set
            </button>
          </div>
          {shownError && (
            <div class="chalk-modal-error" data-testid="reminder-modal-error">
              {shownError}
            </div>
          )}
        </div>
        <footer class="chalk-modal-footer">
          <button
            type="button"
            class="chalk-button"
            onClick={onCancel}
            data-testid="reminder-modal-cancel"
          >
            cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
