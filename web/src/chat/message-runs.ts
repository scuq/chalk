// 137-2: a run is a group of rows from one author. The phone shows the name
// and the time on the first row of a run only.

/** RUN_GAP_MS is the longest gap, in milliseconds, between two messages of one run. */
export const RUN_GAP_MS = 5 * 60 * 1000;

/** A RunMessage holds the fields of a message that decide its run. */
export interface RunMessage {
  sender: string;
  senderUserID: string;
  ts: Date;
  deleted?: boolean;
}

// author returns the key of the sender: the user id first, then the device id.
// It returns "" when both are empty, as for a purged sender.
function author(m: RunMessage): string {
  if (m.senderUserID !== "") return `u:${m.senderUserID}`;
  if (m.sender !== "") return `d:${m.sender}`;
  return "";
}

/**
 * continuesRun reports whether cur continues the run of prev.
 *
 * It returns true when neither message is deleted, both have the same
 * non-empty author, and cur is 0 ms to RUN_GAP_MS after prev. Two devices of
 * one account count as one author. A purged sender never joins a run.
 */
export function continuesRun(prev: RunMessage, cur: RunMessage): boolean {
  if (prev.deleted || cur.deleted) return false;
  const a = author(prev);
  if (a === "" || a !== author(cur)) return false;
  const gap = cur.ts.getTime() - prev.ts.getTime();
  return Number.isFinite(gap) && gap >= 0 && gap <= RUN_GAP_MS;
}
