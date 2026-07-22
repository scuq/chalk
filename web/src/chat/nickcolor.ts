// Phase 9.7f: per-user name colors in chat (the old Psi/IRC affordance).
//
// WHY HUE, NOT HEX
// ----------------
// 9.7e stored a literal #rrggbb per handle. That can't survive theme
// switching: a colour picked to read against tokyo-night's #1a1b26 is
// unreadable on snazzy-light's #fafbfc, and vice versa. So we store only the
// HUE (0..359) and let CSS supply saturation + lightness per theme:
//
//   :root                       { --nick-s: 65%; --nick-l: 68%; }  /* dark  */
//   [data-theme="snazzy-light"] { --nick-s: 68%; --nick-l: 32%; }  /* light */
//   .chalk-message-sender--tinted { color: hsl(var(--nick-h) var(--nick-s) var(--nick-l)); }
//
// One stored number per user stays correct on every theme, including any
// theme added later. The colour <input> still works -- we just derive the hue
// from whatever the user picks and discard their lightness choice, which is
// the part that can't be theme-portable anyway.
//
// Everything here is pure so it can be unit-tested without a DOM.

// Blueish, per the default-self-colour requirement.
export const DEFAULT_SELF_HUE = 210;

// clampHue normalises anything (including junk from a hand-edited prefs blob)
// into 0..359. Non-finite input falls back to the default rather than
// producing NaN in a CSS custom property, which would silently kill the rule.
export function clampHue(h: number): number {
  if (typeof h !== "number" || !Number.isFinite(h)) return DEFAULT_SELF_HUE;
  return ((Math.round(h) % 360) + 360) % 360;
}

// hueFromString derives a stable hue from a handle. FNV-1a: tiny, no deps,
// and well spread for short ASCII strings, which is all we feed it. Stability
// matters more than distribution quality -- the same person must keep the
// same colour across reloads, devices, and clients, with nothing stored.
export function hueFromString(s: string): number {
  let h = 0x811c9dc5;
  const t = s.toLowerCase();
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

// hueFromHex pulls the hue out of #rrggbb (the shape <input type="color">
// emits). Returns null for anything unparseable so callers can fall through
// to their next source rather than rendering a broken colour. A greyscale
// input has no meaningful hue; we report 0 rather than null so an explicit
// pick of grey is still honoured as a pick.
export function hueFromHex(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return clampHue(h * 60);
}

// hexFromHue renders a hue as #rrggbb for seeding <input type="color">, which
// can't take an hsl(). Mid saturation/lightness so the swatch reads sensibly
// in the picker regardless of the active theme -- this value is only ever the
// input's starting point, never what gets rendered in chat.
export function hexFromHue(hue: number, s = 0.65, l = 0.6): string {
  const h = clampHue(hue) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const toC = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const to255 = (v: number): string =>
    Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${to255(toC(h + 1 / 3))}${to255(toC(h))}${to255(toC(h - 1 / 3))}`;
}

export interface NickHueInput {
  // Master switch (chat prefs). False => nothing is tinted at all.
  enabled: boolean;
  // Is this the viewer's own message? Own messages use the self colour.
  own: boolean;
  // The sender's handle. Colours key off the handle, not the user id, so the
  // same person looks the same to everyone without any shared state.
  handle: string | null | undefined;
  selfHue: number;
  // Explicit per-handle picks (lowercased keys), from the roster picker.
  userHues: Record<string, number>;
  // Back-compat: 9.7e's hex rules, already scope-filtered by the caller.
  // An explicit hue wins; a legacy hex is honoured before falling back to
  // the automatic hash, so upgrading doesn't silently recolour anyone.
  legacyColorByHandle?: Map<string, string>;
}

// resolveNickHue returns the hue to render a sender label in, or null to
// leave it at the theme's default colour.
//
// Precedence: disabled -> none; own -> self colour; explicit pick; legacy
// 9.7e hex rule; automatic hash of the handle.
export function resolveNickHue(o: NickHueInput): number | null {
  if (!o.enabled) return null;
  if (o.own) return clampHue(o.selfHue);

  const key = String(o.handle ?? "").trim().toLowerCase();
  // No handle => no stable identity to colour by. Falls back to the plain
  // label rather than hashing a UUID prefix, which would change if the
  // handle later loads in.
  if (!key) return null;

  const explicit = o.userHues?.[key];
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return clampHue(explicit);
  }

  const legacy = o.legacyColorByHandle?.get(key);
  if (legacy) {
    const h = hueFromHex(legacy);
    if (h !== null) return h;
  }

  return hueFromString(key);
}
