// 97-1: the voice diagnostics ring, as its own module so the SESSION can own
// it. The 30-4c ring lived inside VoiceCall, which meant a ws-drop reconnect
// destroyed it: handleWsDown tears the call down and the auto-rejoin builds a
// fresh one, so "copy report" after a reconnect showed only the new call --
// the events that led up to the drop died with the old one. The ring is now a
// value the session constructs once per page load and threads into every call
// it creates (VoiceCallOptions.diag); a call without a session (the guest
// room) makes a private one and loses nothing it ever had.

/** One timestamped diagnostics event. */
export interface VoiceDiagEvent {
  t: number; // unix millis
  msg: string;
}

/** Sized for a session that spans several calls -- the per-call 30-4c ring
 * held 150; this one also carries the previous call plus the session edges
 * between them. */
export const DIAG_RING_MAX = 300;

/** Bounded, append-only event ring. push() mirrors to the debug console,
 * which is the "temporary [voice-dbg] traces made permanent" behaviour the
 * per-call ring had. */
export class VoiceDiagRing {
  private readonly ring: VoiceDiagEvent[] = [];

  constructor(private readonly max: number = DIAG_RING_MAX) {}

  push(msg: string): void {
    this.ring.push({ t: Date.now(), msg });
    if (this.ring.length > this.max) {
      this.ring.splice(0, this.ring.length - this.max);
    }
    console.debug("[voice]", msg);
  }

  /** A snapshot copy, oldest first. */
  events(): VoiceDiagEvent[] {
    return [...this.ring];
  }
}

/** The candidate-pair fields a trouble snapshot renders (97-2). Structurally
 * a subset of VoicePeerDiag["pair"], declared here so the formatter has no
 * import back into call.ts. */
export interface DiagPair {
  localType: string;
  localAddr: string;
  remoteType: string;
  remoteAddr: string;
  protocol: string;
  rttMs?: number;
  bytesSent?: number;
  bytesReceived?: number;
}

/** describePair flattens a selected candidate pair into one ring line --
 * the same shape the drawer's live stats row uses, so a snapshot taken at
 * failure reads like the row the user would have seen had they been looking. */
export function describePair(p: DiagPair): string {
  let s = `${p.localType}(${p.localAddr}) ⇄ ${p.remoteType}(${p.remoteAddr}) ${p.protocol}`;
  if (p.rttMs !== undefined) s += ` rtt=${p.rttMs}ms`;
  if (p.bytesSent !== undefined && p.bytesReceived !== undefined) {
    s += ` ↑${Math.round(p.bytesSent / 1024)}KiB ↓${Math.round(p.bytesReceived / 1024)}KiB`;
  }
  return s;
}
