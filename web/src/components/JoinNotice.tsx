// 82-8: "who just joined this channel", above the composer.
//
// WHY THIS EXISTS, and it is not a courtesy. Channel membership is asserted by
// the SERVER -- nothing signs it (phase 83 is the authenticated channel-state
// transcript that would). Meanwhile any key holder auto-reshares the channel
// key to whoever appears in the roster. So a server that adds a principal it
// controls gets the channel key handed to it, promptly, by a legitimate
// member's client, with no attacker-side cryptography at all.
//
// Phase 82 cannot close that -- signing a wrap says who SENT a key, not who
// deserved one. What it can do is deny the attack its silence. A roster that
// grows without saying so is the difference between an attack nobody can
// notice and one somebody might.
//
// Deliberately NOT a message in the feed: a synthetic row would need a seq,
// which means colliding with the real sequence space, persisting, and counting
// as unread. This is a session-scoped notice about something that just
// happened, which is exactly what it looks like.

interface Props {
  joins: Array<{ userID: string; handle: string }>;
  onDismiss: () => void;
}

export function JoinNotice({ joins, onDismiss }: Props) {
  if (joins.length === 0) return null;

  // Name everyone: "and 3 others" is precisely the summarization that would
  // let one unexpected member hide behind two expected ones.
  const names = joins.map((j) => j.handle || j.userID);

  return (
    <div class="chalk-join-notice" role="status" data-testid="join-notice">
      <span class="chalk-join-notice-text">
        {names.length === 1
          ? `${names[0]} joined this channel — they can read messages from now on.`
          : `${names.join(", ")} joined this channel — they can read messages from now on.`}
      </span>
      <button
        type="button"
        class="chalk-join-notice-dismiss"
        onClick={onDismiss}
        aria-label="dismiss"
        title="dismiss"
      >
        ✕
      </button>
    </div>
  );
}
