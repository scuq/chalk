// chalk-web -- the parking lot's boss key.
//
// F9 puts chalk on the parking lot from anywhere in the app, and (53-4) takes
// it off again, back to the channel, thread and side panel that were open. The
// same hard limit the voice keybinds have applies here (see voice/hotkeys.ts):
// a web page cannot claim an OS-global hotkey, so this only fires while a chalk
// tab has focus. That is the case it is for -- someone walking up behind you
// while you are reading chalk.
//
// Two deliberate differences from the voice binds:
//
//   * it fires while you are typing. Whoever walks up does not wait for the
//     composer to lose focus, and F9 types nothing, so eating it in a textarea
//     costs nothing.
//   * for a moment after the key parks, it will not un-park. The key is hit in
//     a hurry and hitting it twice is what a hurry looks like; a panicked
//     double-tap must not put back on screen what the first press just took off
//     it. Waiting out the guard is the whole cost of being wrong about that.

export const PARKING_HOTKEY_CODE = "F9";

// What to call the key in a tooltip. Matched on KeyboardEvent.code like the
// voice binds, so it is the physical F9 on every layout.
export const PARKING_HOTKEY_LABEL = "F9";

// Comfortably longer than a double-tap (two presses land ~150-250ms apart),
// short enough that someone who parked on purpose and immediately changed
// their mind does not think the key is broken.
export const PARKING_UNPARK_GUARD_MS = 600;

export type ParkingPress = "park" | "unpark" | "ignore";

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
 * decideParkingPress says what an unmodified F9 means right now.
 * `sinceKeyPark` is milliseconds since this key last parked, or Infinity if it
 * never did -- parking by clicking the sidebar row is not the thing the guard
 * defends against, so it does not arm it.
 */
export function decideParkingPress(parked: boolean, sinceKeyPark: number): ParkingPress {
  if (!parked) return "park";
  return sinceKeyPark < PARKING_UNPARK_GUARD_MS ? "ignore" : "unpark";
}

export interface ParkingHotkeyHandlers {
  isParked: () => boolean;
  park: () => void;
  unpark: () => void;
}

/**
 * installParkingHotkey attaches the listener and returns an uninstall function.
 * `now` is injectable for tests; nothing else passes it.
 */
export function installParkingHotkey(
  handlers: ParkingHotkeyHandlers,
  now: () => number = () => Date.now(),
): () => void {
  let keyParkedAt = -Infinity;

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isParkingHotkey(e)) return;
    e.preventDefault();
    if (e.repeat) return;

    const press = decideParkingPress(handlers.isParked(), now() - keyParkedAt);
    if (press === "ignore") return;
    if (press === "unpark") {
      handlers.unpark();
      return;
    }
    // Leaving focus in the composer would keep a caret (and on a phone, the
    // on-screen keyboard) on a field the parked screen no longer shows.
    const active = document.activeElement as HTMLElement | null;
    if (active && typeof active.blur === "function") active.blur();
    keyParkedAt = now();
    handlers.park();
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
