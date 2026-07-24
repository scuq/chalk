// chalk-web -- phase31-slice31-6b in-memory KEK hand-off.
//
// The signup wizard (and, in 31-7, the login flow) derives the password KEK
// while the password is in hand, but the encryption-phrase entropy only
// exists later, inside IdentitySetupScreen. This module carries the KEK
// across that gap: module-level memory only, never IndexedDB/localStorage,
// consumed exactly once (takeKEK zeroes the reference), gone on page reload.
// Losing it is harmless -- the wrap upload is best-effort and can be redone
// from the profile (31-8) or at next login (31-7).

let held: Uint8Array | null = null;

/** setKEK stashes the freshly derived password KEK (32 bytes). */
export function setKEK(kek: Uint8Array): void {
  held = kek;
}

/** takeKEK returns the held KEK once and clears the stash. */
export function takeKEK(): Uint8Array | null {
  const k = held;
  held = null;
  return k;
}

/** peekKEK returns the held KEK WITHOUT consuming it (unlock attempts). */
export function peekKEK(): Uint8Array | null {
  return held;
}

/** hasKEK reports whether a KEK is currently held (UI hinting only). */
export function hasKEK(): boolean {
  return held !== null;
}
