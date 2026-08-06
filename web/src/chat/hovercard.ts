// chalk-web -- the roster hover card's one rule (92-2).
//
// The card shows a friend's name, their presence state, and how long it has
// been since they were last active. Only the last of those needs deciding:
// name and state are read straight off the roster row.
import { fmtRelative } from "./reltime";

// lastSeenLine renders the card's "last seen" line, or null when the card
// should not carry one.
//
// Two cases produce no line. An online friend: the dot already says "now", so
// the line would read "last seen just now" under a green dot forever. And an
// unusable timestamp: a user with no device_presence rows aggregates to a zero
// time.Time server-side, whose UnixMilli() is a large negative number -- so the
// test is `> 0`, not a truthiness check.
export function lastSeenLine(
  state: string,
  lastSeenMS: number | undefined,
  now: Date,
): string | null {
  if (state === "online") return null;
  if (lastSeenMS === undefined || lastSeenMS <= 0) return null;
  return `last seen ${fmtRelative(new Date(lastSeenMS), now)}`;
}
