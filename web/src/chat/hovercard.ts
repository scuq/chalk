// chalk-web -- what a hover card says (92-2, 92-4, 92-5, 92-6).
//
// The card itself is components/HoverCard.tsx; everything that decides which
// of its lines exist and what they read lives here, where it can be tested
// without a browser. Two builders, one per surface: a roster row and a sender
// name in the message feed. They agree on the shape (PersonCardInfo) and
// differ in what they know -- the roster knows the friend and whether a DM
// exists, the feed knows the device a message came from and nothing about
// friendship.
import { fmtRelative } from "./reltime";
import { presenceLabel } from "./presence";

// PersonCardInfo is one card, resolved. Every field but `name` is optional in
// the sense that null means "draw no line": a card with nothing to add beyond
// a name is a card with one line, not a card with four blanks.
export interface PersonCardInfo {
  // The handle, or the best fallback the surface has for someone without one.
  name: string;
  // Nick colour hue for the name, or null to leave it untinted -- the same
  // rule the message feed uses for senders it cannot resolve.
  hue: number | null;
  // The profile display name, when it is not just the handle again (92-5).
  displayName: string | null;
  // Presence as a word ("online" / "away" / "offline"), or null for no
  // presence line at all. Null is not the same as "offline": the feed shows
  // no line for someone we have no presence subscription to, because
  // presence subscriptions are friends-only server-side and claiming a
  // non-friend is offline would be a guess dressed up as a fact.
  state: string | null;
  seen: string | null;
  // "start chat" -- the roster's action hint.
  hint: string | null;
  // The dim identity footer: which account and which device (92-6). This is
  // what the feed's old native `title` carried, kept because it is the only
  // place a multi-device sender can be told apart.
  meta: string | null;
}

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

// displayNameLine is the card's second line, or null when it would only
// repeat the first (92-5).
//
// A user who never set a display name has "" on the directory row; one who
// set it to their own username has a line identical to the name above it.
// Both are noise, and the friends panel's directory list already drops them
// by the same rule.
export function displayNameLine(
  name: string,
  displayName: string | undefined,
): string | null {
  const d = (displayName ?? "").trim();
  if (d === "") return null;
  if (d.toLowerCase() === name.trim().toLowerCase()) return null;
  return d;
}

// rosterCardInfo builds the card for a desktop roster row (92-1).
export function rosterCardInfo(args: {
  userID: string;
  handle: string;
  hue: number | null;
  presence: string | undefined;
  displayName: string | undefined;
  lastSeenMS: number | undefined;
  // True when no DM with this friend exists yet, which is exactly when
  // clicking the row makes one and so the only time the hint is worth saying.
  showHint: boolean;
  now: Date;
}): PersonCardInfo {
  // Handle-less friends fall back to a userID slice, matching the row.
  const name = args.handle || args.userID.slice(-8);
  const state = presenceLabel(args.presence);
  return {
    name,
    hue: args.hue,
    displayName: args.handle
      ? displayNameLine(args.handle, args.displayName)
      : null,
    state,
    seen: lastSeenLine(state, args.lastSeenMS, args.now),
    hint: args.showHint ? "start chat" : null,
    meta: null,
  };
}

// senderCardInfo builds the card for a sender name in the message feed (92-6).
//
// `handle` is null when the channel's member list doesn't name the sender --
// a purged account, or a message older than sender_user_id. `userID` and
// `device` are empty strings in the same situations, which is why every
// branch here tests for "" rather than assuming an id is present.
export function senderCardInfo(args: {
  userID: string;
  device: string;
  handle: string | null;
  hue: number | null;
  own: boolean;
  presence: string | undefined;
  displayName: string | undefined;
  lastSeenMS: number | undefined;
  now: Date;
}): PersonCardInfo {
  const fallback =
    args.device === ""
      ? "unknown sender"
      : // Same slice the row's label uses, so the card names what you hovered.
        args.device.slice(-8);
  let name = args.handle || fallback;
  if (args.own) name = args.handle ? `${args.handle} (you)` : "you";

  // No presence line for yourself (the dot would tell you what you already
  // know) and none for anyone we hold no presence entry for -- see the
  // PersonCardInfo comment.
  const state =
    args.own || args.presence === undefined
      ? null
      : presenceLabel(args.presence);

  const ids: string[] = [];
  if (args.userID !== "") ids.push(`user ${args.userID.slice(0, 8)}…`);
  if (args.device !== "") ids.push(`device ${args.device.slice(0, 8)}…`);

  return {
    name,
    hue: args.hue,
    displayName: args.handle
      ? displayNameLine(args.handle, args.displayName)
      : null,
    state,
    seen: state === null ? null : lastSeenLine(state, args.lastSeenMS, args.now),
    hint: null,
    meta: ids.length > 0 ? ids.join(" · ") : "unknown sender",
  };
}
