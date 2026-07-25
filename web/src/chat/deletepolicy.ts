// 35-3: who may delete which message, and what deleting even means in a
// given channel. The server enforces the same rules; this exists so the UI
// never offers an action that would come back refused.
//
//   "own"        -- DM. There is no owner worth the name in a two-person
//                   channel, and neither member may erase the other's words,
//                   so the only delete is your own message.
//   "unilateral" -- group channel, dictator mode. The owner deletes for
//                   everyone, including the author. Callers confirm twice.
//   "proposal"   -- group channel, democratic mode. Any member may ask, the
//                   channel decides: the action opens a delete_message
//                   proposal instead of deleting.

export type DeleteMode = "own" | "unilateral" | "proposal";

export interface DeleteChannel {
  isDM?: boolean;
  governanceMode?: string;
  createdBy?: string | null;
}

export function deleteModeFor(ch: DeleteChannel | null | undefined): DeleteMode {
  if (!ch) return "unilateral";
  if (ch.isDM) return "own";
  return ch.governanceMode === "democratic" ? "proposal" : "unilateral";
}

/** Whether selfUserID may act on a message authored by senderUserID. */
export function canDeleteMessage(
  ch: DeleteChannel | null | undefined,
  senderUserID: string | null | undefined,
  selfUserID: string | null | undefined,
): boolean {
  if (!ch || !selfUserID) return false;
  switch (deleteModeFor(ch)) {
    case "own":
      return !!senderUserID && senderUserID === selfUserID;
    case "proposal":
      return true;
    case "unilateral":
      return ch.createdBy === selfUserID;
  }
}
