// Phase 117-1: the hue picker.
//
// A name colour is a HUE and nothing else -- saturation and lightness come
// from the theme so one stored number reads on every ground (the reasoning
// is at the top of chat/nickcolor.ts). 9.7f still offered <input
// type="color">, a full picker whose saturation and lightness were quietly
// thrown away on every pick: choose a pale peach, reopen, and the picker sat
// on a saturated orange it had never been told to. This is the honest
// control instead -- one strip of every hue, painted in the theme's own
// saturation and lightness so the strip IS the palette chat will render
// from, and a live preview beside it. Nothing on it can be chosen and lost.
//
// The strip commits on change (mouse-up / key release), not on every pixel
// of a drag: each commit is a prefs round-trip that fans out to the person's
// other devices. The preview follows the drag through local state.
import { useEffect, useState } from "preact/hooks";
import { clampHue, nickTintStyle } from "../chat/nickcolor";

export interface HueSliderProps {
  hue: number;
  onChange: (hue: number) => void;
  // Preview text painted in the live hue ("you"); without it a dot swatch
  // stands in, the same 10px one the roster menu's title used to carry.
  label?: string;
  id?: string;
  testid?: string;
  ariaLabel?: string;
}

export function HueSlider({ hue, onChange, label, id, testid, ariaLabel }: HueSliderProps) {
  const [live, setLive] = useState(clampHue(hue));
  // "auto" and a pick on another device both change the prop under us.
  useEffect(() => setLive(clampHue(hue)), [hue]);
  const read = (e: Event): number => clampHue(Number((e.target as HTMLInputElement).value));
  return (
    <>
      <input
        type="range"
        class="chalk-hue-slider"
        min={0}
        max={359}
        step={1}
        value={live}
        id={id}
        data-testid={testid}
        aria-label={ariaLabel ?? "name hue"}
        aria-valuetext={`hue ${live}`}
        onInput={(e) => setLive(read(e))}
        onChange={(e) => onChange(read(e))}
      />
      {label ? (
        <span class="chalk-nick-preview" style={nickTintStyle(live)}>
          {label}
        </span>
      ) : (
        <span class="chalk-nick-swatch" style={nickTintStyle(live, "background")} />
      )}
    </>
  );
}
