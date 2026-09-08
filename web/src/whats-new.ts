// 116-2: what's new -- the note chalk shows once per person after an update.
//
// A feature nobody is told about is a feature nobody finds (112-6 learned
// that for the profile picture), and the CHANGELOG is a file on github,
// which is not where a person reading a chat is. So the client carries a
// short, hand-written note per phase, and shows the ones a person has not
// read yet -- until they say they have.
//
// Keyed by PHASE NUMBER, not by version. A release is cut after the code
// (the /release skill names it), so a note written with the code cannot know
// its version; a phase number is known the moment the work starts, it is
// what the paperwork is filed under, and "newer" is plain integer order.
//
// The read mark lives in account prefs (`whatsNewRead`, the highest phase
// read), for 112-6's reason: per device it would show again on every new
// browser. Closing the note without ticking "read" hides it for the session
// only -- it comes back on the next load, which is the point of the tick.
//
// Keep the list short: the last release or two. Older entries are pruned at
// release time -- anyone that far behind gets the changelog link instead.

export interface WhatsNewEntry {
  /** the phase this note describes; the read mark is the highest one read */
  phase: number;
  title: string;
  /** one line each, written for a chalk user: what they can now do */
  lines: string[];
  /** where to find it, e.g. "settings → appearance → flair" */
  where?: string;
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    phase: 115,
    title: "flair, off until you ask for it",
    lines: [
      "a small flame on any channel where more than a few messages land within a few minutes (four in four by default, both adjustable)",
      "a wave through a friend's name in the roster when they come online or send you a direct message",
      "a slow drift across a channel's pinned image",
      "a frame around your profile picture -- ember, aurora, pulse, matrix green, frost or gold -- that everyone with flair on sees in the roster, the members list, hover cards and call tiles, moving while you are online",
      "each effect has its own switch, and everything holds still when your system asks for reduced motion",
    ],
    where: "settings → appearance → flair",
  },
];

/** latestWhatsNew is the highest phase the list describes, or 0 for an empty list. */
export function latestWhatsNew(entries: WhatsNewEntry[] = WHATS_NEW): number {
  return entries.reduce((m, e) => Math.max(m, e.phase), 0);
}

/**
 * parseWhatsNewRead turns whatever the prefs blob holds into a phase number:
 * a non-number, a negative or a NaN reads as "nothing read".
 */
export function parseWhatsNewRead(raw: unknown): number {
  // A number, or a string holding one. Not Number(x) on anything: true is
  // 1 and [] is 0 under that, and neither was ever a phase.
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** unreadWhatsNew returns the entries newer than the read mark, newest first. */
export function unreadWhatsNew(
  read: number,
  entries: WhatsNewEntry[] = WHATS_NEW,
): WhatsNewEntry[] {
  return entries.filter((e) => e.phase > read).sort((a, b) => b.phase - a.phase);
}
