// chalk-web -- composer keyboard shortcuts and the help sheet behind the "?"
// button.
//
// Matched on KeyboardEvent.code (the physical key) for the same reason the
// voice keybinds are (see voice/hotkeys.ts): a shortcut learned on QWERTY must
// not move when the layout does.
//
// Ctrl and Meta are both accepted on every platform. Mac users expect ⌘,
// everyone else expects ctrl, and there is no case where honouring the other
// one gets in the way -- the composer has no ctrl/meta shortcuts that mean two
// different things.
//
// The three chosen combos are the ones mainstream chat clients already train
// people on (Ctrl+E for emoji, Ctrl+G for GIFs) plus a shifted F for "file",
// which avoids the browser's own Ctrl+F.

import { PARKING_HOTKEY_LABEL } from "../parking-hotkey";

export type ComposerAction = "emoji" | "gif" | "file";

interface Shortcut {
  action: ComposerAction;
  code: string;
  shift: boolean;
  // Key part of the label, e.g. "shift+f". The ctrl/⌘ prefix is added by
  // shortcutLabel so it can follow the platform.
  keys: string;
}

const SHORTCUTS: Shortcut[] = [
  { action: "emoji", code: "KeyE", shift: false, keys: "e" },
  { action: "gif", code: "KeyG", shift: false, keys: "g" },
  { action: "file", code: "KeyF", shift: true, keys: "shift+f" },
];

// The subset of KeyboardEvent the matcher needs, so tests can pass a literal.
export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function matchComposerShortcut(e: KeyLike): ComposerAction | null {
  // Alt is excluded rather than ignored: on several layouts AltGr arrives as
  // ctrl+alt, and typing a bracket must not open the emoji picker.
  if (e.altKey) return null;
  if (!e.ctrlKey && !e.metaKey) return null;
  for (const s of SHORTCUTS) {
    if (s.code === e.code && s.shift === e.shiftKey) return s.action;
  }
  return null;
}

export function isMacPlatform(platform?: string): boolean {
  const p =
    platform ??
    (typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent : "");
  return /Mac|iPhone|iPad|iPod/i.test(p);
}

const mod = (mac: boolean): string => (mac ? "⌘" : "ctrl");

export function shortcutLabel(action: ComposerAction, mac: boolean): string {
  const s = SHORTCUTS.find((x) => x.action === action);
  if (!s) return "";
  return `${mod(mac)}+${s.keys}`;
}

export interface HelpRow {
  keys: string;
  what: string;
}

// composerHelp is the whole cheat sheet -- shortcuts plus the composer
// behaviours people never discover on their own (shift+enter, cursor-up to
// edit). One list so the popover and any future docs cannot drift apart.
export function composerHelp(mac: boolean): HelpRow[] {
  return [
    { keys: "enter", what: "send" },
    { keys: "shift+enter", what: "new line" },
    { keys: "@", what: "mention a member" },
    { keys: "↑", what: "edit your last message" },
    { keys: "esc", what: "cancel editing" },
    { keys: shortcutLabel("emoji", mac), what: "emoji picker" },
    { keys: shortcutLabel("gif", mac), what: "GIF picker" },
    { keys: shortcutLabel("file", mac), what: "attach a file" },
    { keys: `${mod(mac)}+v`, what: "paste a screenshot" },
    // Not a composer key, but this sheet is the only place anyone goes looking
    // for one, and the boss key fires mid-sentence -- so it belongs here.
    { keys: PARKING_HOTKEY_LABEL, what: "hide the conversation" },
  ];
}
