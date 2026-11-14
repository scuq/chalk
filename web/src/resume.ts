// 135-6: what the WebSocket client does when the page comes back from the
// background, as a pure function.
//
// A phone freezes or suspends a page in the background. When it shows
// again, the socket can be dead while it still looks open, or a reconnect
// can wait out a long backoff. A chat must catch up at once, so a return
// to the page either reconnects now or checks the open socket with a ping.

import type { ConnectionState } from "./ws-client";

export type ResumeAction = "none" | "reconnect-now" | "probe" | "wait";

/** resumeAction returns what the client does when the page shows again.
 *   - stopped: none, the client gave up on purpose.
 *   - open: probe, a ping must come back.
 *   - a reconnect waits on its backoff timer: reconnect now.
 *   - connecting: wait, the connect timeout covers a stuck dial. */
export function resumeAction(i: { state: ConnectionState; stopped: boolean; reconnectPending: boolean }): ResumeAction {
  if (i.stopped) return "none";
  if (i.state === "open") return "probe";
  if (i.reconnectPending) return "reconnect-now";
  if (i.state === "connecting") return "wait";
  return "none";
}
