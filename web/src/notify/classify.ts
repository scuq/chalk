// chalk-web -- which sound, if any, does an arriving message deserve?
//
// One message must produce at most one sound, so the four chat categories
// are a precedence order rather than a set of independent tests. Kept
// here, pure and structurally typed, because it is the part that is easy
// to get subtly wrong (your own message, a reply in a thread you never
// touched) and hard to check by hand in a browser.

import type { NotifyEventType } from "./rules";

// Just enough of a Message to decide. Structural on purpose: the notify
// module has no business importing app state types.
export interface MessageFacts {
  senderUserID: string;
  body: string;
  parentID?: string;
}

export interface ViewerFacts {
  id: string;
  handle: string;
}

export interface Surroundings {
  isDM: boolean;
  // Did the viewer write the parent, or any reply already in this thread?
  // The caller resolves this, because it needs the cached thread.
  threadInvolvesViewer: boolean;
}

// mentionsHandle is passed in rather than imported so this module stays
// independent of chat/, and so the tests can check the precedence order
// without reimplementing handle matching.
export type MentionTest = (body: string, handle: string) => boolean;

// categoryForMessage returns null when the message should make no sound
// at all -- which is only ever true for your own messages. Everything
// else is somebody else talking, and the quietest answer is "message".
export function categoryForMessage(
  m: MessageFacts,
  me: ViewerFacts,
  where: Surroundings,
  mentions: MentionTest,
): NotifyEventType | null {
  // Your own words, arriving back at you. The sending tab is
  // echo-suppressed server-side, but your other devices and any
  // post-reconnect replay do deliver this.
  if (m.senderUserID === me.id) return null;

  // A DM outranks a mention: in a 1:1 every message is already directed
  // at you, so "someone wrote your handle" tells you nothing the channel
  // hasn't, and hearing the DM sound is the more useful signal. (The plan
  // had these the other way round; this is the one place it was wrong.)
  if (where.isDM) return "dm";

  if (me.handle && mentions(m.body, me.handle)) return "mention";

  // A reply in a thread you have nothing to do with is just a message.
  if (m.parentID && where.threadInvolvesViewer) return "thread_reply";

  return "message";
}
