// The one unread-dot implementation (33-2), extracted from Sidebar in 62-6
// so the sidebar and the Zuckermode conversation list can never disagree
// about what a dot looks like. A dot, not a count: "something new there" is
// the whole message. A mention upgrades it to the accent color: same
// glance, louder answer.
export function UnreadDot({ mention }: { mention: boolean }) {
  const label = mention ? "unread, you were mentioned" : "unread messages";
  return (
    <span
      class={`chalk-unread-dot ${mention ? "chalk-unread-dot--mention" : ""}`}
      data-testid={mention ? "sidebar-mention-dot" : "sidebar-unread-dot"}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}
