// chalk-web -- global voice keybinds (Phase 30 Addendum A4).
//
// One window-level listener for the three voice keys: the push-to-talk /
// push-to-mute hold key, self-mute, and deafen. Bindings are stored as
// KeyboardEvent.code, so they follow the PHYSICAL key -- someone on a German
// layout who binds the key left of "1" keeps that key, and a bind made on QWERTY
// does not move when the layout does.
//
// A hard limit worth stating plainly, because it shapes what these are good
// for: a web page cannot claim an OS-global hotkey. These fire only while a
// chalk tab has focus. Push-to-talk therefore works when chalk is the window
// you are looking at, and NOT when you are in a game with chalk behind it --
// which is precisely the case the design doc had in mind. There is no API that
// fixes this; navigator.keyboard.lock() only applies in fullscreen and still
// only sees keys already routed to the page.

import { loadMicPrefs, subscribeMicPrefs, type MicPrefs } from "./mic-prefs";
import { voiceSession } from "./session";

/** keyLabel turns a KeyboardEvent.code into something worth showing a person. */
export function keyLabel(code: string): string {
  if (!code) return "unassigned";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^Numpad/.test(code)) return `numpad ${code.slice(6).toLowerCase() || "?"}`.trim();

  const named: Record<string, string> = {
    Space: "space",
    Enter: "enter",
    Tab: "tab",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    ControlLeft: "left ctrl",
    ControlRight: "right ctrl",
    ShiftLeft: "left shift",
    ShiftRight: "right shift",
    AltLeft: "left alt",
    AltRight: "right alt",
    MetaLeft: "left meta",
    MetaRight: "right meta",
    CapsLock: "caps lock",
    Insert: "insert",
    Delete: "delete",
    Home: "home",
    End: "end",
    PageUp: "page up",
    PageDown: "page down",
  };
  return named[code] ?? code;
}

/**
 * isTypingTarget reports whether a key event is someone writing rather than
 * reaching for a shortcut. Without this, binding "M" to mute would silently eat
 * every M typed into the composer.
 */
export function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || typeof node.tagName !== "string") return false;
  const tag = node.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return node.isContentEditable === true;
}

/**
 * installVoiceHotkeys attaches the listeners and returns an uninstall function.
 * Safe to call once at app start: the handlers no-op when nothing is bound and
 * voiceSession ignores mute/deafen outside a call.
 */
export function installVoiceHotkeys(): () => void {
  let prefs: MicPrefs = loadMicPrefs();
  const unsubscribe = subscribeMicPrefs((p) => {
    prefs = p;
    // A rebind while the old key is physically down would otherwise strand the
    // hold state -- we will never see the keyup for a key we no longer watch.
    releaseHold();
  });

  let holding = false;
  const releaseHold = () => {
    if (!holding) return;
    holding = false;
    voiceSession.setKeyHeld(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    // A bare modifier is a legitimate PTT key, but a COMBINATION is not ours:
    // Ctrl+M is the browser's or the OS's, and stealing it would be rude.
    const combo = e.ctrlKey || e.altKey || e.metaKey;

    if (prefs.keyTalk && e.code === prefs.keyTalk) {
      e.preventDefault(); // Space would scroll the transcript.
      if (e.repeat || holding) return;
      holding = true;
      voiceSession.setKeyHeld(true);
      return;
    }
    if (e.repeat || combo) return;
    if (prefs.keyMute && e.code === prefs.keyMute) {
      e.preventDefault();
      voiceSession.toggleMute();
      return;
    }
    if (prefs.keyDeafen && e.code === prefs.keyDeafen) {
      e.preventDefault();
      voiceSession.toggleDeafen();
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (prefs.keyTalk && e.code === prefs.keyTalk) releaseHold();
  };

  // Alt-tabbing away mid-transmission must not leave the mic pinned open: the
  // keyup lands in whatever window took focus, never here. Same for a tab that
  // gets hidden. This is a privacy bug, not a polish item.
  const onBlur = () => releaseHold();
  const onVisibility = () => {
    if (document.visibilityState !== "visible") releaseHold();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    releaseHold();
    unsubscribe();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
