// chalk-web -- per-device display preferences (font family, font size, layout width).
//
// Deliberately NOT server-synced prefs like theme. The whole point is
// that the phone and the desktop disagree: a 14px mono that reads fine
// on a 27" monitor is squint-inducing on a phone held at arm's length.
// So these live in localStorage, keyed per browser, and never leave the
// device.
//
// Every knob is applied as an inline custom property on <html>:
//
//   --chalk-font            the family stack (an alias into --chalk-font-*)
//   --chalk-font-scale      a multiplier every font-size in theme.css runs
//                           through, so one value resizes the whole UI
//   --chalk-scrollbar-width thin, or none to hide the bars entirely
//   --chalk-scroll-lane     the message pane's right padding, which only
//                           exists to keep the scrollbar off the text
//   --chalk-app-max-w       the shell's max-width: 1100px, or none to let
//                           the app fill the window (93-1)
//
// Inline styles outrank the :root and [data-theme=...] blocks, so the
// device preference wins over whatever the active theme sets.

import { useCallback, useEffect, useState } from "preact/hooks";

// "mono" is Hack, and stays spelled that way: devices have been storing
// it since 34-1, and renaming the value would silently reset everyone's
// font. Only its label changed once it stopped being the only monospace.
export type FontChoice = "mono" | "jetbrains" | "fira" | "cascadia" | "sans" | "serif";

// 93-1: an enum rather than a boolean. "centered" names what the layout
// already is, and a third step (a wider fixed column) is a value away,
// where fullWidth: true/false would have needed a migration.
export type AppWidth = "centered" | "full";

export interface DisplayPrefs {
  font: FontChoice;
  scale: number;
  hideScrollbars: boolean;
  appWidth: AppWidth;
}

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
  font: "mono",
  scale: 1,
  hideScrollbars: false,
  appWidth: "centered",
};

const STORAGE_KEY = "chalk.display.v1";

// Clamp bounds rather than an enum: the stored value only ever comes
// from the steps below, but a hand-edited localStorage entry shouldn't
// be able to render the app unusable (or invisible).
export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.5;

// Each value needs a matching --chalk-font-<value> stack in theme.css;
// theme-fonts.test.ts holds the two files to that.
export const FONT_CHOICES: { value: FontChoice; label: string; desc: string }[] = [
  { value: "mono", label: "hack", desc: "bundled, default" },
  { value: "jetbrains", label: "jetbrains mono", desc: "bundled, ligatures" },
  { value: "fira", label: "fira code", desc: "bundled, ligatures" },
  { value: "cascadia", label: "cascadia code", desc: "bundled, ligatures" },
  { value: "sans", label: "sans", desc: "system UI face" },
  { value: "serif", label: "serif", desc: "system serif" },
];

export const SCALE_STEPS: { value: number; label: string }[] = [
  { value: 0.85, label: "extra small" },
  { value: 0.925, label: "small" },
  { value: 1, label: "normal" },
  { value: 1.1, label: "large" },
  { value: 1.25, label: "extra large" },
];

export const APP_WIDTH_CHOICES: { value: AppWidth; label: string }[] = [
  { value: "centered", label: "centered (default)" },
  { value: "full", label: "full window" },
];

// The centred cap, kept here rather than only in theme.css because
// applyDisplayPrefs is what writes it. theme.css repeats it as the custom
// property's fallback, for the render before this runs.
export const CENTERED_MAX_WIDTH = "1100px";

function isFontChoice(v: unknown): v is FontChoice {
  return FONT_CHOICES.some((f) => f.value === v);
}

function isAppWidth(v: unknown): v is AppWidth {
  return APP_WIDTH_CHOICES.some((w) => w.value === v);
}

// normalizeDisplayPrefs turns anything at all into usable prefs: an
// unknown font or a missing/NaN scale falls back to the default, and an
// out-of-range scale is clamped instead of rejected.
export function normalizeDisplayPrefs(raw: unknown): DisplayPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DISPLAY_PREFS };
  const o = raw as Record<string, unknown>;
  const font = isFontChoice(o.font) ? o.font : DEFAULT_DISPLAY_PREFS.font;
  const n = typeof o.scale === "number" ? o.scale : Number(o.scale);
  const scale = Number.isFinite(n)
    ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, n))
    : DEFAULT_DISPLAY_PREFS.scale;
  const hideScrollbars =
    typeof o.hideScrollbars === "boolean"
      ? o.hideScrollbars
      : DEFAULT_DISPLAY_PREFS.hideScrollbars;
  const appWidth = isAppWidth(o.appWidth) ? o.appWidth : DEFAULT_DISPLAY_PREFS.appWidth;
  return { font, scale, hideScrollbars, appWidth };
}

// The subset of HTMLElement applyDisplayPrefs needs, so the unit tests
// can hand it a stub instead of standing up a DOM.
export interface StyleTarget {
  style: { setProperty(name: string, value: string): void };
}

export function applyDisplayPrefs(prefs: DisplayPrefs, target?: StyleTarget): void {
  const el = target ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  el.style.setProperty("--chalk-font", `var(--chalk-font-${prefs.font})`);
  el.style.setProperty("--chalk-font-scale", String(prefs.scale));
  el.style.setProperty("--chalk-scrollbar-width", prefs.hideScrollbars ? "none" : "thin");
  // The lane goes with the bar: 8px of dead space on the right of the feed
  // reads as a misalignment once there's no scrollbar standing in it.
  el.style.setProperty("--chalk-scroll-lane", prefs.hideScrollbars ? "0px" : "var(--chalk-s2)");
  // margin: 0 auto stays on the shell either way -- at max-width: none
  // centring is a no-op, so there is nothing to undo.
  el.style.setProperty(
    "--chalk-app-max-w",
    prefs.appWidth === "full" ? "none" : CENTERED_MAX_WIDTH,
  );
}

export function loadDisplayPrefs(): DisplayPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DISPLAY_PREFS };
    return normalizeDisplayPrefs(JSON.parse(raw));
  } catch {
    // Private-browsing localStorage throws, and a corrupt entry throws
    // in JSON.parse. Neither is worth breaking startup over.
    return { ...DEFAULT_DISPLAY_PREFS };
  }
}

export function saveDisplayPrefs(prefs: DisplayPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Same as above: the setting just won't survive a reload.
  }
}

// useDisplayPrefs owns the setting for whatever component renders the
// picker. There's no app-level state to thread it through -- nothing on
// the server knows or cares about it -- so the hook reads, applies, and
// persists on its own.
export function useDisplayPrefs(): [DisplayPrefs, (next: Partial<DisplayPrefs>) => void] {
  const [prefs, setPrefs] = useState<DisplayPrefs>(loadDisplayPrefs);

  const update = useCallback((patch: Partial<DisplayPrefs>) => {
    setPrefs((prev) => {
      const next = normalizeDisplayPrefs({ ...prev, ...patch });
      applyDisplayPrefs(next);
      saveDisplayPrefs(next);
      return next;
    });
  }, []);

  // A second tab on the same device is the same device: follow its
  // changes rather than letting the two disagree until reload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = loadDisplayPrefs();
      applyDisplayPrefs(next);
      setPrefs(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return [prefs, update];
}
