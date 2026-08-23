// 83-7 (D.6): observed roster-change notices, above the composer beside the
// 82-8 join notice.
//
// The join notice is EVENT-sourced: the server said "someone joined" and the
// client repeated it. These are OBSERVED: the client itself diffed the
// roster it now sees against the one it last persisted, so they fire even
// for a change that produced no event at all -- a direct database write
// included. The "observed" tag is the distinction made visible, and the
// wording says WHAT changed, never who did it: no trustworthy actor record
// exists for the change this notice exists to catch.

import { noticeText, type RosterNotice } from "../chat/roster-observe";

interface Props {
  notices: RosterNotice[];
  onDismiss: () => void;
}

export function RosterNoticeBar({ notices, onDismiss }: Props) {
  if (notices.length === 0) return null;
  const alarming = notices.some((n) => n.kind === "key-changed" || n.kind === "added");
  return (
    <div
      class={`chalk-roster-notice ${alarming ? "chalk-roster-notice--alarm" : ""}`}
      role="status"
      data-testid="roster-notice"
    >
      <span class="chalk-roster-notice-tag" title="Derived by this device from comparing the member list against the one it last saw — not from a server event.">
        observed
      </span>
      <span class="chalk-roster-notice-text">
        {/* Name every change: summarizing is how one unexpected member hides
            behind two expected ones (the 82-8 lesson). */}
        {notices.map((n) => noticeText(n)).join(" · ")}
      </span>
      <button
        type="button"
        class="chalk-roster-notice-dismiss"
        onClick={onDismiss}
        aria-label="dismiss"
        title="dismiss"
      >
        ✕
      </button>
    </div>
  );
}
