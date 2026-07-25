// 37-3: which messages you may edit, and which one cursor-up targets.
//
// Editing is deliberately narrower than deleting. Deletion is a moderation
// action a channel can have opinions about -- owners do it, channels vote on
// it. Editing is not: nobody but the author ever gets to change what an
// author said, so there is no owner path and no proposal path here.
//
// Two rules, and they are not the same rule:
//
//   - canEditMessage is the SERVER's rule, mirrored so the UI never offers an
//     action that would come back refused: your own message, not deleted, and
//     younger than EDIT_WINDOW_MS.
//   - lastEditableMessage is a UI AFFORDANCE, not a security boundary. The
//     feature exists for "fix the typo you just sent", so cursor-up targets
//     your most recent message and the row menu only offers editing there.
//     The server does not enforce last-ness -- a crafted client could edit any
//     of its own messages inside the window, which is fine: they are that
//     author's own words either way, and the age window is what actually
//     constrains rewriting a conversation.

/**
 * How long after sending a message its author may still edit it. Must match
 * `editWindow` in internal/server/ws.go -- if these drift, the UI offers edits
 * the server refuses (or hides ones it would allow).
 */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

export interface EditableMessage {
  senderUserID: string;
  ts: Date;
  seq: number;
  deleted?: boolean;
  clientMsgID?: string;
}

/**
 * Whether selfUserID may edit this message right now. nowMs is passed in
 * rather than read from the clock so callers can re-evaluate on a timer and
 * tests need no fake clock.
 */
export function canEditMessage(
  m: EditableMessage | null | undefined,
  selfUserID: string | null | undefined,
  nowMs: number,
): boolean {
  if (!m || !selfUserID) return false;
  if (m.deleted) return false;
  if (!m.senderUserID || m.senderUserID !== selfUserID) return false;
  // An optimistic row still carries its local id and has no server seq yet;
  // editing it would target a message id the server has never heard of.
  if (m.clientMsgID !== undefined && m.seq <= 0) return false;
  return nowMs - m.ts.getTime() < EDIT_WINDOW_MS;
}

/**
 * The message cursor-up should open for editing: the caller's most recent
 * editable message in the list. Returns null when there is nothing to edit.
 *
 * Scans from the end because the newest message is the overwhelmingly common
 * hit -- you press up right after sending -- so this is O(1) in practice even
 * though the list is an array rather than an index.
 */
export function lastEditableMessage<T extends EditableMessage>(
  messages: readonly T[],
  selfUserID: string | null | undefined,
  nowMs: number,
): T | null {
  if (!selfUserID) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && canEditMessage(m, selfUserID, nowMs)) return m;
  }
  return null;
}
