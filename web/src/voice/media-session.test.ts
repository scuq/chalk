import { test } from "node:test";
import assert from "node:assert/strict";
import { installMediaSession, mediaSessionPlan } from "./media-session";

test("the plan is active only in a call, and the mic is on only when not muted", () => {
  assert.deepEqual(mediaSessionPlan({ phase: "joining", muted: false, camOn: false, channelName: "lounge" }), { active: false, mic: false, cam: false, title: "chalk · lounge" });
  assert.deepEqual(mediaSessionPlan({ phase: "in-call", muted: true, camOn: true, channelName: null }), { active: true, mic: false, cam: true, title: "chalk · voice" });
});

test("a call sets the handlers and the state, the end of the call clears them", () => {
  let snap = { phase: "idle", muted: false, camOn: false, channelName: "lounge" as string | null };
  const subs = new Set<() => void>();
  const session = { subscribe: (fn: () => void) => (subs.add(fn), () => subs.delete(fn)), snap: () => snap };
  const set = (p: Partial<typeof snap>) => { snap = { ...snap, ...p }; subs.forEach((f) => f()); };
  const handlers: Record<string, unknown> = {};
  const calls: string[] = [];
  const ms = {
    metadata: null as unknown,
    setActionHandler: (a: string, fn: (() => void) | null) => { handlers[a] = fn; },
    setMicrophoneActive: (on: boolean) => calls.push(`mic ${on}`),
    setCameraActive: (on: boolean) => { if (on) throw new Error("not here"); calls.push(`cam ${on}`); },
  };
  class Meta { constructor(public init: { title: string; artist: string }) {} }
  let hung = 0;
  const off = installMediaSession(session, ms, Meta, { toggleMic: () => {}, toggleCam: () => {}, hangUp: () => { hung++; } });
  assert.equal(handlers.hangup, undefined);

  set({ phase: "in-call" });
  assert.equal(typeof handlers.hangup, "function");
  assert.equal((ms.metadata as Meta).init.title, "chalk · lounge");
  assert.deepEqual(calls, ["mic true", "cam false"]);
  (handlers.hangup as () => void)();
  assert.equal(hung, 1);

  // A throwing action does not stop the rest.
  set({ camOn: true, muted: true });
  assert.deepEqual(calls.slice(-1), ["mic false"]);

  set({ phase: "idle" });
  assert.equal(handlers.hangup, null);
  assert.equal(ms.metadata, null);
  off();
});

test("without the API nothing happens", () => {
  const off = installMediaSession({ subscribe: () => () => {}, snap: () => ({ phase: "in-call", muted: false, camOn: false, channelName: null }) }, undefined, undefined, { toggleMic: () => {}, toggleCam: () => {}, hangUp: () => {} });
  off();
});
