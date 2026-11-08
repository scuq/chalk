// The one unread marker implementation (33-2), extracted from Sidebar in
// 62-6 so the sidebar and the Zuckermode conversation list can never
// disagree about what the marker looks like. It is a small envelope, not a
// count: "something new there" is the whole message. Unread and mention
// use the same filled envelope. Unread has the theme color. A mention has
// the accent color and a glow. A conversation that was read shows nothing.
// The CSS draws the glyph (132-3). The class name keeps "dot" from the
// time when the marker was a round dot.
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
