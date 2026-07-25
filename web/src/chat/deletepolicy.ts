// 35-3: who may delete which message, and what deleting it costs.
//
// One rule set, used by the channel feed and the thread panel alike:
//
//   - Your own message is always yours to delete, in any channel and either
//     governance mode. Nobody votes on whether you may retract your own
//     words.
//   - Someone else's message is never yours in a DM.
//   - Someone else's message in a group channel follows governance: the
//     owner deletes unilaterally in dictator mode (confirmed twice, since it
//     erases another member's words with no recourse), and in democratic
//     mode any member may open a delete_message proposal the channel votes
//     on -- nobody deletes it alone.
//
// The server enforces the same rules; this exists so the UI never offers an
// action that would come back refused.

export type DeleteAction = "none" | "own" | "unilateral" | "proposal";

export interface DeleteChannel {
  isDM?: boolean;
  governanceMode?: string;
  createdBy?: string | null;
}

export function deleteActionFor(
  ch: DeleteChannel | null | undefined,
  senderUserID: string | null | undefined,
  selfUserID: string | null | undefined,
): DeleteAction {
  if (!ch || !selfUserID) return "none";
  if (senderUserID && senderUserID === selfUserID) return "own";
  if (ch.isDM) return "none";
  if (ch.governanceMode === "democratic") return "proposal";
  return ch.createdBy === selfUserID ? "unilateral" : "none";
}

/** The row-menu label: a democratic delete only asks the channel. */
export function deleteLabelFor(action: DeleteAction): string {
  return action === "proposal" ? "propose deletion" : "delete";
}
