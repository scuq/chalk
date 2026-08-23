// 54-2: channel-group helpers for the create modal (and, in 54-4, the
// per-user override UI). Pure so they can be tested without a DOM.
//
// The enemy here is fragmentation: free-text group names would happily
// produce "General", "general" and "Genral" as three groups. So the UI
// offers the groups that already exist (knownGroups feeds a <datalist>),
// and whatever the user types is canonicalized against them -- a
// case-insensitive match adopts the existing spelling instead of minting
// a near-duplicate.

import type { ChannelSummary } from "../state/types";

// The server-side default (migration 0048). Typing it explicitly and
// omitting it entirely must land in the same group.
export const DEFAULT_GROUP = "General";

// 54-4: the group a channel actually files under for THIS user -- their
// override when set, else the creator's suggestion; blank means the default.
export function effectiveGroup(
  ch: ChannelSummary,
  overrides: Record<string, string> = {}
): string {
  const g = (overrides[ch.id] ?? ch.groupName).trim();
  return g || DEFAULT_GROUP;
}

// Distinct group names across the user's non-DM channels (as the user sees
// them, overrides applied), sorted with DEFAULT_GROUP first. This is the
// datalist behind the create modal's group field and the move-to-group row.
export function knownGroups(
  channels: ChannelSummary[],
  overrides: Record<string, string> = {}
): string[] {
  const seen = new Map<string, string>(); // lower-cased -> first-seen casing
  seen.set(DEFAULT_GROUP.toLowerCase(), DEFAULT_GROUP);
  for (const ch of channels) {
    if (ch.isDM) continue;
    const g = effectiveGroup(ch, overrides);
    const key = g.toLowerCase();
    if (!seen.has(key)) seen.set(key, g);
  }
  return [...seen.values()].sort((a, b) =>
    a === DEFAULT_GROUP ? -1 : b === DEFAULT_GROUP ? 1 : a.localeCompare(b)
  );
}

// Resolve what the user typed to the group name that should be sent:
// trimmed; empty means the default; a case-insensitive match against an
// existing group adopts that group's casing.
export function canonicalizeGroup(input: string, known: string[]): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_GROUP;
  const match = known.find((g) => g.toLowerCase() === trimmed.toLowerCase());
  return match ?? trimmed;
}

// ---- 100-1: the voice section ----------------------------------------------

// Partition the visible roster by channel kind. Voice rooms render in their
// own sidebar section above "channels", flat and ungrouped -- a room you join
// is a different thing from a feed you read, and there are rarely more than a
// handful. Text channels keep the whole 54-3 grouping machinery. Order within
// each half is the input order, untouched.
export function splitVoice(channels: ChannelSummary[]): {
  voice: ChannelSummary[];
  text: ChannelSummary[];
} {
  const voice: ChannelSummary[] = [];
  const text: ChannelSummary[] = [];
  for (const ch of channels) {
    (ch.channelType === "voice" ? voice : text).push(ch);
  }
  return { voice, text };
}

// ---- 54-3: grouped roster --------------------------------------------------

// One rendered group. key is the lower-cased name -- the identity groups
// merge under and the identity collapse state is stored against, so
// "Dev"/"dev" stay one group and stay collapsed together.
export interface RosterGroup {
  key: string;
  name: string; // first-seen casing
  channels: ChannelSummary[];
}

// Partition channels into ordered groups: DEFAULT_GROUP first, the rest
// alphabetical. Channel order within a group is the input order (the
// sidebar's newest-first), untouched. Callers pass non-DM channels only;
// a channel with a blank group lands in DEFAULT_GROUP. Overrides (54-4)
// move individual channels for this user.
export function groupRoster(
  channels: ChannelSummary[],
  overrides: Record<string, string> = {}
): RosterGroup[] {
  const byKey = new Map<string, RosterGroup>();
  for (const ch of channels) {
    const name = effectiveGroup(ch, overrides);
    const key = name.toLowerCase();
    let g = byKey.get(key);
    if (!g) {
      g = { key, name, channels: [] };
      byKey.set(key, g);
    }
    g.channels.push(ch);
  }
  const defaultKey = DEFAULT_GROUP.toLowerCase();
  return [...byKey.values()].sort((a, b) =>
    a.key === defaultKey ? -1 : b.key === defaultKey ? 1 : a.name.localeCompare(b.name)
  );
}

// ---- collapse state ---------------------------------------------------------
//
// Which groups are folded up is per-machine by design (localStorage, like
// the parked flag): collapse is ephemeral posture, and syncing it would
// fold groups on your other screens behind your back. Stored as an array
// of group KEYS.

const COLLAPSED_KEY = "chalk.roster.collapsed.v1";

export function loadCollapsedGroups(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    // Private browsing (or node tests) -- everything expanded is the safe
    // reading of "we don't know".
    return new Set();
  }
}

export function saveCollapsedGroups(collapsed: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Nothing to do; the fold still applies until reload.
  }
}
