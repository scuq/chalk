// 136-3: the page reads the mark of the iOS app.
//
// The app adds `window.chalkIOS` at document start, before any page script runs.
// The desktop app does the same with `window.chalkDesktop`.
// The page reads the mark by its shape and trusts nothing else in it.
// The page uses the mark to hide the notes that are true only in a browser,
// and to receive the phone-call event.

/** The name of the window event that the app dispatches when a phone call connects. */
export const IOS_PHONE_CALL_EVENT = "chalk-ios-phone-call";

/** The part of `window.chalkIOS` that the page reads. */
interface IOSShellMark {
  shell?: unknown;
}

/**
 * iosShellPresent reports whether w carries the mark of the iOS app. The mark
 * is a `chalkIOS.shell` string that starts with "chalk-ios/". By default w is
 * the window, and the result is false when there is no window.
 */
export function iosShellPresent(w: unknown = typeof window === "undefined" ? undefined : window): boolean {
  const mark = (w as { chalkIOS?: IOSShellMark } | undefined)?.chalkIOS;
  return typeof mark?.shell === "string" && mark.shell.startsWith("chalk-ios/");
}

/**
 * installIOSPhoneCallListener calls onPhoneCall each time the app dispatches
 * the phone-call event. Outside the iOS app it adds no listener. It returns a
 * function that removes the listener.
 */
export function installIOSPhoneCallListener(onPhoneCall: () => void): () => void {
  if (typeof window === "undefined" || !iosShellPresent()) return () => {};
  const handler = () => onPhoneCall();
  window.addEventListener(IOS_PHONE_CALL_EVENT, handler);
  return () => window.removeEventListener(IOS_PHONE_CALL_EVENT, handler);
}
