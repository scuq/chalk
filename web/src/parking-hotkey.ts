// chalk-web -- the parking lot's boss key.
//
// F9 puts chalk on the parking lot from anywhere in the app. The same hard
// limit the voice keybinds have applies here (see voice/hotkeys.ts): a web page
// cannot claim an OS-global hotkey, so this only fires while a chalk tab has
// focus. That is the case it is for -- someone walking up behind you while you
// are reading chalk.
//
// Two deliberate differences from the voice binds:
//
//   * it fires while you are typing. Whoever walks up does not wait for the
//     composer to lose focus, and F9 types nothing, so eating it in a textarea
//     costs nothing.
//   * it only ever parks. A second press does NOT bring the conversation back,
//     so a panicked double-tap cannot un-hide what the first press hid. The way
//     back is the same as always: pick a channel.

export const PARKING_HOTKEY_CODE = "F9";

// What to call the key in a tooltip. Matched on KeyboardEvent.code like the
// voice binds, so it is the physical F9 on every layout.
export const PARKING_HOTKEY_LABEL = "F9";

interface KeyLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function isParkingHotkey(e: KeyLike): boolean {
  if (e.code !== PARKING_HOTKEY_CODE) return false;
  // A modified F9 is somebody else's -- the browser's, the window manager's --
  // and stealing it would be rude.
  return !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
}

/**
 * installParkingHotkey attaches the listener and returns an uninstall function.
 * `park` is called on every unmodified F9, including while already parked --
 * making that a no-op is the caller's business.
 */
export function installParkingHotkey(park: () => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isParkingHotkey(e)) return;
    e.preventDefault();
    if (e.repeat) return;
    // Leaving focus in the composer would keep a caret (and on a phone, the
    // on-screen keyboard) on a field the parked screen no longer shows.
    const active = document.activeElement as HTMLElement | null;
    if (active && typeof active.blur === "function") active.blur();
    park();
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
