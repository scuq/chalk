// 115-3: a name that can wave.
//
// Renders as plain text until a wave is running for its person; then the
// name becomes one inline-block span per letter, so each can rise and fall
// on its own delay. The wrapper is keyed on the wave's start time: a second
// trigger while the first is still running remounts the letters, which is
// what restarts a CSS animation.
//
// No inline styles. The per-letter delay is an :nth-child rule in theme.css
// (WAVE_MAX_LETTERS of them), not a custom property set from here --
// nickcolor.ts records why chalk does not set custom properties inline.
//
// Screen readers get the whole name from the wrapper's label; the letters
// are hidden from them, or a five-letter handle would be read as five words.

import { WAVE_MAX_LETTERS, splitLetters } from "../chat/wave";

interface Props {
  name: string;
  /** when this person's wave started, or null for no wave */
  since: number | null;
}

export function WaveName({ name, since }: Props) {
  if (since === null) return <>{name}</>;
  const letters = splitLetters(name);
  return (
    <span
      key={since}
      class="chalk-flair-wave"
      data-testid="flair-wave"
      aria-label={name}
      role="img"
    >
      {letters.map((ch, i) => (
        <span
          key={i}
          class={`chalk-flair-wave-ch ${i >= WAVE_MAX_LETTERS ? "chalk-flair-wave-ch--tail" : ""}`}
          aria-hidden="true"
        >
          {ch}
        </span>
      ))}
    </span>
  );
}
