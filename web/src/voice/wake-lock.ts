// 135-7: keep the screen on during a call, so that the phone does not dim
// and lock in the middle of it.
//
// The browser releases the lock when the page hides. For this reason the
// code asks for the lock again each time the page shows during a call.
// The Screen Wake Lock API is in Chromium and, for installed web apps, in
// iOS 18.4 and later. Where the API is absent, nothing happens.

/** wantWakeLock reports whether the screen must stay on. */
export function wantWakeLock(inCall: boolean, visible: boolean): boolean {
  return inCall && visible;
}

interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: "release", fn: () => void): void;
}
interface WakeLockNav {
  wakeLock?: { request(type: "screen"): Promise<Sentinel> };
}
interface SessionLike {
  subscribe(fn: () => void): () => void;
  snap(): { phase: string };
}
interface DocLike {
  visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

/** installWakeLock holds a screen wake lock while the session is in a call
 * and the page shows. It returns the function that removes it. */
export function installWakeLock(session: SessionLike, nav: WakeLockNav, doc: DocLike): () => void {
  let held: Sentinel | null = null;
  let asking = false;
  const update = () => {
    const want = wantWakeLock(session.snap().phase === "in-call", doc.visibilityState === "visible");
    if (want && !held && !asking && nav.wakeLock) {
      asking = true;
      nav.wakeLock
        .request("screen")
        .then((s) => {
          asking = false;
          held = s;
          s.addEventListener("release", () => {
            if (held === s) held = null;
          });
          // The call can end while the request waits.
          if (!wantWakeLock(session.snap().phase === "in-call", doc.visibilityState === "visible")) {
            held = null;
            void s.release().catch(() => {});
          }
        })
        .catch(() => {
          asking = false;
        });
    } else if (!want && held) {
      const s = held;
      held = null;
      void s.release().catch(() => {});
    }
  };
  const unsubscribe = session.subscribe(update);
  doc.addEventListener("visibilitychange", update);
  update();
  return () => {
    unsubscribe();
    doc.removeEventListener("visibilitychange", update);
    if (held) void held.release().catch(() => {});
    held = null;
  };
}
