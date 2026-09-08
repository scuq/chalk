// 115-3: the wave -- what a name is cut into so its letters can move.
//
// Pure, so the cut is testable: the store (wave-store.ts) owns who is
// waving and the clock, the component owns the markup, and this owns the
// one decision that could go wrong quietly -- how a name becomes letters.

// A wave runs this long from its trigger. Long enough to be seen in a
// roster you were not looking at, short enough that two friends arriving a
// few seconds apart read as two events rather than a permanent wobble.
export const WAVE_MS = 2400;

// The CSS carries one animation-delay rule per letter position, and
// exactly this many. Letters past the cap share the last delay, which reads
// fine: by then the wave has visibly passed and the tail just settles.
export const WAVE_MAX_LETTERS = 16;

/**
 * splitLetters cuts a name into the units the wave animates: code points,
 * not UTF-16 units, so an emoji or an accented letter in a handle moves as
 * one glyph rather than as a broken pair. Spaces become no-break spaces
 * because the letters render inline-block and a bare space would collapse.
 */
export function splitLetters(name: string): string[] {
  return Array.from(name).map((ch) => (ch === " " ? " " : ch));
}
