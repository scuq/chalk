// RemindersPanel: the list of the message reminders of this user.
//
// Phase 87-4. Opened from the Reminders row of the sidebar on a desktop, and
// from the head button of the conversation list on a phone. It uses the overlay
// pattern and the chrome classes of ThreadInboxPanel (the card, the header, the
// empty state), so the two panels look the same. The rows have their own
// `chalk-reminders-*` classes.
//
// THE ROWS are the reminders that are not done. The fired reminders come first,
// the latest fired first. The pending reminders follow, the earliest due time
// first. The order is panelRows in chat/reminders.ts. A row shows the channel
// name, how long ago the message was sent, the due time, and the preview. A
// pending reminder shows the time until it is due. A fired reminder shows "due"
// and how long ago.
//
// THREE ACTIONS on each row:
//   jump    -- show the message in its channel. The row itself is the button.
//   snooze  -- open the presets and a date and time field, in the row
//   done    -- remove the row
// A reminder whose channel is not in `channelNames` (the user left it, or it is
// gone) shows "channel not available" and has a disabled jump button. Snooze and
// done still work, because they need only the reminder.
//
// Presentational: App owns the reminder set, the jump, and the saves. This file
// holds only the state of the snooze choices and the clock.

import { useEffect, useState } from "preact/hooks";
import { useIsMobile } from "../mobile";
import { useSwipeBack } from "../chat/use-swipe-back";
import { fmtRelative, fmtUntil } from "../chat/reltime";
import {
  PRESET_LABELS,
  REMINDER_PRESETS,
  dueAtFor,
  fromLocalInput,
  toLocalInput,
  type Reminder,
  type ReminderPreset,
} from "../chat/reminders";

interface Props {
  // The reminders to list, already filtered and ordered by panelRows.
  rows: Reminder[];
  // Channel ID to display name. An ID that is missing shows "channel not
  // available".
  channelNames: Record<string, string>;
  // The jump. App closes the panel and shows the message.
  onJump: (r: Reminder) => void;
  // dueAt is the new due time in epoch milliseconds. It is always in the future
  // when the panel calls this function.
  onSnooze: (r: Reminder, dueAt: number) => void;
  onDone: (r: Reminder) => void;
  onClose: () => void;
}

export function RemindersPanel({ rows, channelNames, onJump, onSnooze, onDone, onClose }: Props) {
  // The ID of the row whose snooze choices are open. At most one row at a time.
  const [snoozeID, setSnoozeID] = useState<string | null>(null);
  // The value of the date and time field, in the datetime-local format.
  const [custom, setCustom] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // The relative times ("in 5m", "2h ago") must stay correct while the panel is
  // open, so the clock state moves every 30 seconds.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Escape closes the snooze choices first. A second press closes the panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (snoozeID !== null) setSnoozeID(null);
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snoozeID, onClose]);

  const isMobile = useIsMobile();
  const swipe = useSwipeBack(isMobile, onClose);

  // The clock is read again at each open, so the presets that the choices offer
  // match the time of the click.
  const toggleSnooze = (r: Reminder) => {
    setNow(Date.now());
    setCustom("");
    setSnoozeID(snoozeID === r.id ? null : r.id);
  };

  // A preset can stop being offered while the choices are open (this evening, at
  // 18:00), and a custom time can be in the past. In both cases dueAtFor returns
  // null. The reminder then keeps its old due time, and the list of choices
  // stays open with a new clock.
  const snooze = (r: Reminder, preset: ReminderPreset) => {
    const dueAt = dueAtFor(preset, Date.now(), fromLocalInput(custom) ?? Number.NaN);
    if (dueAt === null) {
      setNow(Date.now());
      return;
    }
    onSnooze(r, dueAt);
    setSnoozeID(null);
  };

  const nowDate = new Date(now);
  const firedTotal = rows.filter((r) => r.firedAt !== null).length;

  return (
    <div class="chalk-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        class={`chalk-modal-card chalk-threadinbox-panel chalk-reminders-panel${swipe.offset !== null ? " chalk-swipe-x" : ""}${swipe.settling ? " chalk-swipe-x--settling" : ""}`}
        style={swipe.offset !== null ? `--chalk-swipe-x:${swipe.offset}px` : undefined}
        role="dialog"
        aria-label="your reminders"
        data-testid="reminders-panel"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={swipe.onTouchStart}
        onTouchMove={swipe.onTouchMove}
        onTouchEnd={swipe.onTouchEnd}
        onTouchCancel={swipe.onTouchCancel}
      >
        <div class="chalk-threadinbox-header">
          <div class="chalk-threadinbox-title">
            reminders
            {rows.length > 0 && <span class="chalk-sidebar-count">({rows.length})</span>}
          </div>
          <div class="chalk-threadinbox-actions">
            <button type="button" class="chalk-modal-close" onClick={onClose} aria-label="close">
              x
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div class="chalk-threadinbox-empty" data-testid="reminders-empty">
            no reminders
            <div class="chalk-threadinbox-empty-hint">
              open the menu of a message and choose "remind me..." to set one.
            </div>
          </div>
        ) : (
          <ul class="chalk-reminders-list" aria-label={`${rows.length} reminders, ${firedTotal} due`}>
            {rows.map((r) => {
              const fired = r.firedAt !== null;
              const chan = channelNames[r.channelID];
              return (
                <li
                  key={r.id}
                  class={`chalk-reminders-item${fired ? " chalk-reminders-item--fired" : ""}`}
                  data-testid={`reminders-row-${r.id}`}
                >
                  <div class="chalk-reminders-row">
                    <button
                      type="button"
                      class="chalk-reminders-jump"
                      disabled={chan === undefined}
                      onClick={() => onJump(r)}
                      title={chan === undefined ? "this channel is not available" : "show the message"}
                      data-testid={`reminders-jump-${r.id}`}
                    >
                      <span class="chalk-reminders-meta">
                        <span class="chalk-reminders-chan">{chan ?? "channel not available"}</span>
                        <span title={new Date(r.messageTS).toLocaleString()}>
                          sent {fmtRelative(new Date(r.messageTS), nowDate)}
                        </span>
                        <span class="chalk-reminders-due" title={new Date(r.dueAt).toLocaleString()}>
                          {fired
                            ? `due ${fmtRelative(new Date(r.dueAt), nowDate)}`
                            : fmtUntil(new Date(r.dueAt), nowDate)}
                        </span>
                      </span>
                      <span class="chalk-reminders-preview">{r.preview ?? "(no preview)"}</span>
                    </button>
                    <div class="chalk-reminders-actions">
                      <button
                        type="button"
                        class="chalk-button"
                        aria-expanded={snoozeID === r.id}
                        onClick={() => toggleSnooze(r)}
                        data-testid={`reminders-snooze-${r.id}`}
                      >
                        snooze
                      </button>
                      <button
                        type="button"
                        class="chalk-button"
                        onClick={() => onDone(r)}
                        data-testid={`reminders-done-${r.id}`}
                      >
                        done
                      </button>
                    </div>
                  </div>
                  {snoozeID === r.id && (
                    <div class="chalk-reminders-snooze" data-testid="reminders-snooze-choices">
                      {/* The presets of the reminder modal, without "custom". The
                          field and the "set" button below stand for it. */}
                      {REMINDER_PRESETS.filter((p) => p !== "custom" && dueAtFor(p, now) !== null).map(
                        (p) => (
                          <button
                            key={p}
                            type="button"
                            class="chalk-button"
                            onClick={() => snooze(r, p)}
                            data-testid={`reminders-snooze-${p}`}
                          >
                            {PRESET_LABELS[p]}
                          </button>
                        ),
                      )}
                      <input
                        type="datetime-local"
                        class="chalk-field-input"
                        aria-label={PRESET_LABELS.custom}
                        min={toLocalInput(now)}
                        value={custom}
                        onInput={(e) => setCustom((e.target as HTMLInputElement).value)}
                        data-testid="reminders-snooze-input"
                      />
                      <button
                        type="button"
                        class="chalk-button chalk-button--primary"
                        disabled={custom === ""}
                        onClick={() => snooze(r, "custom")}
                        data-testid="reminders-snooze-set"
                      >
                        set
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
