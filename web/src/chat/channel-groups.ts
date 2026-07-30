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

// Distinct group names across the user's non-DM channels, sorted with
// DEFAULT_GROUP first. This is the datalist behind the create modal's
// group field.
export function knownGroups(channels: ChannelSummary[]): string[] {
  const seen = new Map<string, string>(); // lower-cased -> first-seen casing
  seen.set(DEFAULT_GROUP.toLowerCase(), DEFAULT_GROUP);
  for (const ch of channels) {
    if (ch.isDM) continue;
    const g = ch.groupName.trim();
    if (!g) continue;
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
