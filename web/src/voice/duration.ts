// duration.ts (126-2): the running-call clock, shared by the sidebar's
// voice dock and the phone's zucker call bar. Split out of VoiceDock.tsx so
// a component that needs only the clock does not pull in the session, pip
// and boost modules behind it.

/** fmtDuration returns a call length as "m:ss", or "h:mm:ss" once it passes
 * one hour. A negative value, from a clock that ran backward, clamps to
 * zero. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
