// 106-3: which of a channel's two names the roster shows.
//
// A channel has a full name (required, up to 80 chars) and an optional
// short name (up to ten). prefs.roster.nameStyle picks which one the
// sidebar and Zuckermode list render; the channel header always shows the
// full name, so the abbreviation is never the only place a name is legible.
// Pure so it can be tested without a DOM.

import type { ChannelSummary } from "../state/types";

export type NameStyle = "full" | "short";

// The character cap on a short name; mirrors the server's
// store.MaxShortNameLen and migration 0054's CHECK (characters, not
// bytes -- count code points the way char_length does).
export const MAX_SHORT_NAME_LEN = 10;

export const NAME_STYLE_CHOICES: { value: NameStyle; label: string; desc: string }[] = [
  { value: "full", label: "full name", desc: "the channel's name as written" },
  { value: "short", label: "short name", desc: "the abbreviation where one is set" },
];

// The roster label for a channel under the given style. Short falls back
// to the full name when no short name is set, so the pref never blanks a
// row. DMs have no short name (their name renders from the other member),
// and callers resolve them through displayName before reaching here.
export function rosterLabel(
  ch: Pick<ChannelSummary, "name" | "shortName">,
  style: NameStyle,
): string {
  if (style === "short") {
    const s = (ch.shortName ?? "").trim();
    if (s) return s;
  }
  return ch.name;
}

// True when the roster shows something other than the full name, so the
// row can carry the full name as a tooltip.
export function labelIsAbbreviated(
  ch: Pick<ChannelSummary, "name" | "shortName">,
  style: NameStyle,
): boolean {
  return rosterLabel(ch, style) !== ch.name;
}

// Code-point length, the way the server (and Postgres char_length)
// counts it. String.length would count a single emoji as two.
export function shortNameLength(s: string): number {
  return Array.from(s.trim()).length;
}

// The filter should find a channel by either name: someone who filed
// "[Gaming] General" under "gaming" expects typing either to hit.
export function filterText(ch: Pick<ChannelSummary, "name" | "shortName">): string {
  const s = (ch.shortName ?? "").trim();
  return s ? `${ch.name} ${s}` : ch.name;
}
