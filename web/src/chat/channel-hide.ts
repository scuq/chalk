// 78-1: hiding channels from the roster, per user.
//
// A hidden channel is still joined and still delivering: messages arrive,
// unread accrues, notification rules fire exactly as before. This is a view
// setting, not a mute -- muting is what the per-channel notification rule
// (50-5) is for, and "hide until a new message" would be self-defeating if
// hiding also silenced the channel.
//
// Two modes, because "I am done with this one" and "not right now" are
// different intentions:
//   always   -- stays off the roster until the user shows it again.
//   untilNew -- a watermark: the channel comes back the moment a message
//               lands past the newest one it had when it was hidden.
//
// Pure like channel-groups.ts, and structurally typed like zucker.ts, so the
// sidebar (ChannelSummary) and the Zuckermode list (ZuckerRow) can both call
// it and neither pulls in a reducer to be tested. The caller supplies the
// live newest-seq -- state.unread, never the channel summary's stale seed.

export type HideMode = "always" | "untilNew";

export interface HiddenChannel {
  mode: HideMode;
  // untilNew only: the newest seq the channel had at the moment it was
  // hidden. Absent reads as 0, so a junk entry errs towards showing the
  // channel rather than swallowing it.
  seq?: number;
}

export function isHidden(
  entry: HiddenChannel | undefined,
  lastSeq: number,
): boolean {
  if (!entry) return false;
  if (entry.mode === "always") return true;
  return lastSeq <= (entry.seq ?? 0);
}

// Split a channel list into what the roster shows and what it holds back,
// preserving input order in both. Generic over the row shape: the sidebar
// passes ChannelSummary, the Zuckermode list passes its own rows.
export function splitHidden<T extends { id: string }>(
  channels: T[],
  entries: Record<string, HiddenChannel>,
  lastSeqFor: (ch: T) => number,
): { visible: T[]; hidden: T[] } {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const ch of channels) {
    if (isHidden(entries[ch.id], lastSeqFor(ch))) hidden.push(ch);
    else visible.push(ch);
  }
  return { visible, hidden };
}

// Drop entries that no longer say anything: channels this user has since
// left, and untilNew watermarks a message has already passed. Called on the
// write path (the same rebuild groupOverrides gets) so prefs don't
// accumulate a record of every channel ever hidden.
export function pruneHidden<T extends { id: string }>(
  entries: Record<string, HiddenChannel>,
  channels: T[],
  lastSeqFor: (ch: T) => number,
): Record<string, HiddenChannel> {
  const next: Record<string, HiddenChannel> = {};
  for (const ch of channels) {
    const entry = entries[ch.id];
    if (entry && isHidden(entry, lastSeqFor(ch))) next[ch.id] = entry;
  }
  return next;
}

// normalizeHidden validates the stored blob, the way clampSidebarWidth
// guards its pref: anything that isn't a known mode reads as "not hidden"
// rather than a crash or a channel nobody can get back.
export function normalizeHidden(raw: unknown): Record<string, HiddenChannel> {
  const out: Record<string, HiddenChannel> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const { mode, seq } = value as { mode?: unknown; seq?: unknown };
    if (mode === "always") {
      out[id] = { mode: "always" };
    } else if (mode === "untilNew") {
      out[id] = {
        mode: "untilNew",
        seq: typeof seq === "number" && Number.isFinite(seq) ? seq : 0,
      };
    }
  }
  return out;
}
