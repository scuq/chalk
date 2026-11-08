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
    phase: 131,
    title: "a call rail, and channels by newest message",
    lines: [
      "in a call on a desktop, a narrow column of small tiles shows left of the sidebar, one for each person and each screen share, with a ring around the one who speaks and a badge for muted, deafened or sharing. a click on a tile takes you back to the call room",
      "on a desktop, the voice bar under the channel list is gone, and so are the names under each voice room. the column left of the sidebar shows the call timer at the top, and every call control and the leave button at the bottom. the channel list runs to the bottom of the window. rest the mouse pointer on the room to see who is in it",
      "channels in a group sort by the newest message first. if you chose \"when they were made\" before, you keep it",
      "while the mouse pointer is over the channel list, the channels stay where they were, so a new message does not move a channel away under the pointer",
    ],
    where: "settings → chat → channel list",
  },
  {
    phase: 129,
    title: "a visitor for the season",
    lines: [
      "in each season, a small animated scene shows in the middle of the top bar now and then, each season has five scenes, a visit stays on one of them, and the next visit shows a different one, and between the seasons chalk shows ten scenes of its own, small nods to films and series. the seasons bring fireworks at new year, snow in winter, petals in spring, butterflies, fireflies, falling leaves, and ghosts and bats around halloween",
      "in a season it comes up to 16 times a day, more in the evening. between seasons it comes at most twice a day, once from 08:00 to 12:00 and once from 16:00 to midnight. a phone in zuckermode shows it in a row above the conversation list. on the evening of 24 december and on new year's eve it stays up from 20:00 to 05:00",
      "it is on by default, you can turn it off for this device, and the administrator can turn it off for the whole server",
      "it holds still when your system asks for reduced motion",
    ],
    where: "settings → appearance → seasonal",
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
