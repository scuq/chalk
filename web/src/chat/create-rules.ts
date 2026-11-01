// 130-2: Rules for the submit button of the create dialog and for the error
// that a submit shows. The functions are pure, so a test can table them.
// A temporary room (a voice room with a lifetime) is the one channel that a
// member can open alone. The other people in it are guests, and guests are
// not members of the server.

/** 130-3: The lifetime, in seconds, that the quick create of the sidebar gives a temporary room. */
export const QUICK_ROOM_TTL_SECS = 8 * 3600;

export interface CreateSubmitInput {
  /** True while the friend list is loading. */
  loading: boolean;
  friendCount: number;
  selectedCount: number;
  voice: boolean;
  /** The room lifetime in seconds. 0 means permanent. */
  ttlSecs: number;
}

export interface CreateSubmitState {
  /** True if the create button is disabled. */
  disabled: boolean;
  /** The message to show when the user submits, or null if there is none. */
  error: string | null;
}

/** isTemporaryRoom reports whether the options make a temporary room: a voice room with a lifetime. */
export function isTemporaryRoom(voice: boolean, ttlSecs: number): boolean {
  return voice && ttlSecs > 0;
}

/**
 * createSubmitState returns the state of the create button and the error that
 * a submit shows. A temporary room needs no member and does not wait for the
 * friend list. For every other channel, the button is disabled while the
 * friend list loads and when the user has no friends. If the user submits
 * with no member picked, the error is "pick at least one member".
 */
export function createSubmitState(i: CreateSubmitInput): CreateSubmitState {
  if (isTemporaryRoom(i.voice, i.ttlSecs)) return { disabled: false, error: null };
  if (i.loading) return { disabled: true, error: null };
  if (i.friendCount === 0) return { disabled: true, error: null };
  if (i.selectedCount < 1) return { disabled: false, error: "pick at least one member" };
  return { disabled: false, error: null };
}
