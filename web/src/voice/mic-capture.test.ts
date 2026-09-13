// 122-1: the capture loop, run against fakes.
//
// What is asserted is the loop's decisions -- exact id, landing check, retry,
// fallback -- not the browser. Every fake counts what happened to it, so a
// stream the loop was supposed to release is proven released.

import test from "node:test";
import assert from "node:assert/strict";

import { captureLanded, captureMic, type CaptureDeps } from "./mic-capture";
import { DEFAULT_MIC_PREFS, type MicPrefs } from "./mic-prefs";

const PREFS: MicPrefs = { ...DEFAULT_MIC_PREFS, deviceId: "id-airpods", deviceLabel: "AirPods Pro" };

const DEVICES = [
  { deviceId: "id-internal", label: "MacBook Pro Microphone" },
  { deviceId: "id-airpods", label: "AirPods Pro" },
];

interface FakeTrack {
  getSettings(): MediaTrackSettings;
  label: string;
  stopped: number;
  stop(): void;
}

function fakeTrack(deviceId: string | undefined, label: string): FakeTrack {
  return {
    label,
    stopped: 0,
    getSettings: () => (deviceId === undefined ? {} : { deviceId }),
    stop() {
      this.stopped++;
    },
  };
}

interface FakeStream {
  track: FakeTrack;
  stream: MediaStream;
}

function fakeStream(deviceId: string | undefined, label = ""): FakeStream {
  const track = fakeTrack(deviceId, label);
  const stream = {
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

function domErr(name: string): DOMException {
  return new DOMException(name, name);
}

/** A gum that answers each call from a script: a stream, or an error to throw. */
function scripted(steps: (FakeStream | DOMException)[]) {
  const calls: MediaStreamConstraints[] = [];
  let slept = 0;
  const deps: CaptureDeps = {
    gum: async (c) => {
      calls.push(c);
      const step = steps.shift();
      if (!step) throw new Error("gum called past the script");
      if (step instanceof DOMException) throw step;
      return step.stream;
    },
    enumerate: async () => DEVICES,
    sleep: async () => {
      slept++;
    },
  };
  return { deps, calls, slept: () => slept };
}

function audioOf(c: MediaStreamConstraints): MediaTrackConstraints {
  return c.audio as MediaTrackConstraints;
}

test("captureLanded: the default always lands", () => {
  assert.equal(captureLanded(fakeTrack("id-internal", "x"), "", ""), true);
});

test("captureLanded: the settings id decides when present", () => {
  assert.equal(captureLanded(fakeTrack("id-airpods", ""), "id-airpods", ""), true);
  assert.equal(captureLanded(fakeTrack("id-internal", ""), "id-airpods", ""), false);
});

test("captureLanded: a matching label rescues a farbled id", () => {
  // Brave: enumeration and settings can disagree on the id within a session.
  assert.equal(captureLanded(fakeTrack("id-other", "AirPods Pro"), "id-airpods", "AirPods Pro"), true);
});

test("captureLanded: with no id in settings the label decides", () => {
  assert.equal(captureLanded(fakeTrack(undefined, "AirPods Pro"), "id-airpods", "AirPods Pro"), true);
  assert.equal(captureLanded(fakeTrack(undefined, "Internal"), "id-airpods", "AirPods Pro"), false);
});

test("captureLanded: nothing to check against is taken at its word", () => {
  assert.equal(captureLanded(fakeTrack(undefined, ""), "id-airpods", "AirPods Pro"), true);
});

test("the first try lands: one attempt, exact id, no sleep", async () => {
  const s = scripted([fakeStream("id-airpods")]);
  const out = await captureMic(PREFS, s.deps, { fallbackToDefault: false });
  assert.equal(out.attempts, 1);
  assert.equal(out.requested, "id-airpods");
  assert.equal(out.landed, "id-airpods");
  assert.equal(out.fellBack, false);
  assert.deepEqual(audioOf(s.calls[0]).deviceId, { exact: "id-airpods" });
  assert.equal(s.slept(), 0);
});

test("two wrong devices then the right one: three attempts, the wrong streams stopped", async () => {
  const wrong1 = fakeStream("id-internal");
  const wrong2 = fakeStream("id-internal");
  const right = fakeStream("id-airpods");
  const s = scripted([wrong1, wrong2, right]);
  const out = await captureMic(PREFS, s.deps, { fallbackToDefault: false });
  assert.equal(out.attempts, 3);
  assert.equal(out.stream, right.stream);
  assert.equal(wrong1.track.stopped, 1);
  assert.equal(wrong2.track.stopped, 1);
  assert.equal(right.track.stopped, 0);
  assert.equal(s.slept(), 2);
});

test("overconstrained every time with fallback: the default, marked as such", async () => {
  const dflt = fakeStream("id-internal");
  const s = scripted([
    domErr("OverconstrainedError"),
    domErr("OverconstrainedError"),
    domErr("OverconstrainedError"),
    domErr("OverconstrainedError"),
    dflt,
  ]);
  const out = await captureMic(PREFS, s.deps, { fallbackToDefault: true });
  assert.equal(out.fellBack, true);
  assert.equal(out.attempts, 4);
  assert.equal(out.requested, "id-airpods");
  assert.equal(out.landed, "id-internal");
  assert.equal(out.stream, dflt.stream);
  assert.equal("deviceId" in audioOf(s.calls[4]), false, "the fallback asks for no device");
  assert.equal(s.slept(), 3);
});

test("overconstrained every time without fallback: throws after N tries, slept N-1 times", async () => {
  const s = scripted([
    domErr("OverconstrainedError"),
    domErr("OverconstrainedError"),
    domErr("OverconstrainedError"),
  ]);
  await assert.rejects(
    captureMic(PREFS, s.deps, { fallbackToDefault: false, attempts: 3 }),
    (err: DOMException) => err.name === "OverconstrainedError",
  );
  assert.equal(s.calls.length, 3);
  assert.equal(s.slept(), 2);
});

test("a wrong device on every try without fallback throws OverconstrainedError", async () => {
  const wrong = fakeStream("id-internal");
  const s = scripted([wrong, fakeStream("id-internal")]);
  await assert.rejects(
    captureMic(PREFS, s.deps, { fallbackToDefault: false, attempts: 2 }),
    (err: DOMException) => err.name === "OverconstrainedError",
  );
  assert.equal(wrong.track.stopped, 1);
});

test("a denial throws at once: one try, no sleep, no fallback", async () => {
  const s = scripted([domErr("NotAllowedError")]);
  await assert.rejects(
    captureMic(PREFS, s.deps, { fallbackToDefault: true }),
    (err: DOMException) => err.name === "NotAllowedError",
  );
  assert.equal(s.calls.length, 1);
  assert.equal(s.slept(), 0);
});

test("a busy device is retried alone, but not in a combined mic+camera request", async () => {
  const alone = scripted([domErr("NotReadableError"), fakeStream("id-airpods")]);
  const out = await captureMic(PREFS, alone.deps, { fallbackToDefault: false });
  assert.equal(out.attempts, 2);

  const combined = scripted([domErr("NotReadableError")]);
  await assert.rejects(
    captureMic(PREFS, combined.deps, { fallbackToDefault: true, video: true }),
    (err: DOMException) => err.name === "NotReadableError",
  );
  assert.equal(combined.calls.length, 1);
  assert.equal(combined.calls[0].video, true, "the camera rides the same request");
});

test("the label leg decides when settings carry no id", async () => {
  const s = scripted([fakeStream(undefined, "Internal"), fakeStream(undefined, "AirPods Pro")]);
  const out = await captureMic(PREFS, s.deps, { fallbackToDefault: false });
  assert.equal(out.attempts, 2);
  assert.equal(out.landed, null);
});

test("a device absent from the first enumeration is not waited for", async () => {
  // Absent means default, at once: a device that is not listed yet is the
  // devicechange watch's business, and the loop must not hold a join for it.
  let listed = 0;
  const s = scripted([fakeStream("id-internal"), fakeStream("id-airpods")]);
  s.deps.enumerate = async () => (listed++ === 0 ? [DEVICES[0]] : DEVICES);
  const out = await captureMic(PREFS, s.deps, { fallbackToDefault: false });
  assert.equal(out.requested, "");
  assert.equal(out.attempts, 1);
  assert.equal(listed, 1);
  assert.equal(s.slept(), 0);
});

test("an absent device resolves to the default with no retry and no fallback mark", async () => {
  const s = scripted([fakeStream("id-internal")]);
  const out = await captureMic(
    { ...PREFS, deviceId: "id-gone", deviceLabel: "USB Interface" },
    s.deps,
    { fallbackToDefault: false },
  );
  assert.equal(out.requested, "");
  assert.equal(out.fellBack, false);
  assert.equal("deviceId" in audioOf(s.calls[0]), false);
  assert.equal(s.slept(), 0);
});

test("a stale id re-resolves by label before the capture", async () => {
  const s = scripted([fakeStream("id-airpods")]);
  const out = await captureMic({ ...PREFS, deviceId: "id-from-last-session" }, s.deps, {
    fallbackToDefault: false,
  });
  assert.equal(out.requested, "id-airpods");
  assert.deepEqual(audioOf(s.calls[0]).deviceId, { exact: "id-airpods" });
});

test("the list is re-read between tries, so a device that vanishes mid-loop yields the default", async () => {
  let listed = 0;
  const s = scripted([domErr("OverconstrainedError"), fakeStream("id-internal")]);
  s.deps.enumerate = async () => (listed++ === 0 ? DEVICES : [DEVICES[0]]);
  const out = await captureMic(PREFS, s.deps, { fallbackToDefault: false });
  assert.equal(out.requested, "");
  assert.equal(out.attempts, 2);
  assert.equal(listed, 2);
});
