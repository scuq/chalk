// Logo -- the chalk mark, inline.
//
// Derived from web/icons/logo.svg: the dark plate, the glow filters and the
// hairline scribble ticks are dropped, since at header size (~26px) a blur is
// a smudge and sub-2px strokes vanish. Inline rather than <img> so the notch
// between the stick and its rounded end can take the active theme's
// background -- an <img> would have to hardcode one theme's colour and would
// show a black wedge on the light themes.
//
// Decorative: the wordmark next to it carries the name, so the svg is
// aria-hidden rather than labelled.

import { useId } from "preact/hooks";

export function Logo({ class: className }: { class?: string }) {
  // Two instances can be mounted at once (header + mobile drawer), so the
  // gradient needs a per-instance id to keep the document's ids unique.
  const gradient = `chalk-logo-green-${useId()}`;

  return (
    <svg
      class={className ?? "chalk-logo"}
      viewBox="0 0 400 400"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradient} x1="70" y1="40" x2="330" y2="350" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#56f09a" />
          <stop offset="0.48" stop-color="#35df83" />
          <stop offset="1" stop-color="#20ce70" />
        </linearGradient>
      </defs>

      <path
        d="M111 42 H291 C329 42 354 68 354 106 V267 C354 305 329 329 291 329
           H178 L106 376 V329 C69 327 47 303 47 267 V106 C47 68 73 42 111 42 Z"
        fill="none"
        stroke={`url(#${gradient})`}
        stroke-width="17"
        stroke-linecap="round"
        stroke-linejoin="round"
      />

      <path
        d="M122.5 211.5 L228.5 105.5 C236.5 97.5 247.5 98.0 255.5 105.0
           L269.0 116.5 C277.0 123.5 277.5 134.0 270.0 141.5 L158.5 253.0 Z"
        fill={`url(#${gradient})`}
      />

      <path
        d="M119.5 214.5 L158.0 253.0 L151.5 259.5 L113.0 221.0 Z"
        fill="var(--chalk-bg)"
      />

      <path
        d="M112.5 222.5 L150.5 260.5 L142.5 268.5 C130.0 281.0 112.0 283.0 101.5 272.5
           C91.0 262.0 93.0 244.0 105.5 231.5 Z"
        fill={`url(#${gradient})`}
      />

      <g
        fill="none"
        stroke={`url(#${gradient})`}
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M157 275 C163 272 168 278 173 274 C178 271 183 278 189 274
             C195 271 199 276 205 273 C211 270 217 276 223 273
             C230 270 236 275 242 272 C250 269 257 275 264 272
             C272 269 280 274 287 271 C295 268 303 273 311 270"
          stroke-width="5.4"
        />
        <path
          d="M164 279 C175 276 183 281 194 277 C206 273 216 280 228 276
             C240 272 252 279 264 275 C278 271 292 277 307 273"
          stroke-width="3.2"
          opacity="0.85"
        />
      </g>
    </svg>
  );
}
