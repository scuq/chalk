// chalk-web -- how a presence state reads on screen.
//
// Phase 9.6c originally; moved out of Sidebar.tsx in 92-4 so the hover card
// can draw its own presence dot. The card lives in components/HoverCard.tsx,
// which Sidebar imports -- leaving these two in Sidebar would have made that
// import a cycle for the sake of eight lines.
//
// Every reader of a PresenceMap goes through these: the roster dot, the
// Zuckermode DM rows, and both hover cards. `undefined` (nobody has told us
// anything about this user) reads as offline, which is what the roster has
// always shown for a friend with no live devices.

// presenceClass maps a state string to a CSS modifier. "online" -> solid
// green; "away" -> solid yellow; everything else (including missing entries)
// -> hollow grey.
export function presenceClass(state: string | undefined): string {
  if (state === "online") return "chalk-presence-dot--online";
  if (state === "away") return "chalk-presence-dot--away";
  return "chalk-presence-dot--offline";
}

export function presenceLabel(state: string | undefined): string {
  if (state === "online") return "online";
  if (state === "away") return "away";
  return "offline";
}
