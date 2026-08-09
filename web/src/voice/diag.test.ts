// 97-1/97-2: the session-owned diagnostics ring and the trouble-snapshot
// formatter. Pure module by design (the same convention mic-prefs set) --
// the wiring through VoiceCall/VoiceSession needs a browser and is exercised
// by using the debug drawer.

import { test } from "node:test";
import assert from "node:assert/strict";

import { VoiceDiagRing, DIAG_RING_MAX, describePair } from "./diag";

/** push mirrors to console.debug; keep the test output readable. */
function quiet<T>(fn: () => T): T {
  const orig = console.debug;
  console.debug = () => {};
  try {
    return fn();
  } finally {
    console.debug = orig;
  }
}

test("ring keeps the newest events and drops the oldest past the cap", () => {
  quiet(() => {
    const ring = new VoiceDiagRing(3);
    for (const m of ["a", "b", "c", "d", "e"]) ring.push(m);
    assert.deepEqual(
      ring.events().map((e) => e.msg),
      ["c", "d", "e"],
    );
  });
});

test("ring default cap spans a session, not just one call", () => {
  quiet(() => {
    const ring = new VoiceDiagRing();
    for (let i = 0; i < DIAG_RING_MAX + 10; i++) ring.push(`m${i}`);
    const got = ring.events();
    assert.equal(got.length, DIAG_RING_MAX);
    assert.equal(got[0].msg, "m10");
    assert.equal(got[got.length - 1].msg, `m${DIAG_RING_MAX + 9}`);
  });
});

test("events() is a snapshot copy", () => {
  quiet(() => {
    const ring = new VoiceDiagRing();
    ring.push("kept");
    const snap = ring.events();
    snap.pop();
    assert.equal(ring.events().length, 1);
  });
});

test("events carry a timestamp", () => {
  quiet(() => {
    const before = Date.now();
    const ring = new VoiceDiagRing();
    ring.push("x");
    const [e] = ring.events();
    assert.ok(e.t >= before && e.t <= Date.now());
  });
});

test("describePair renders the full line when everything is known", () => {
  const s = describePair({
    localType: "relay",
    localAddr: "203.0.113.7:3478",
    remoteType: "srflx",
    remoteAddr: "198.51.100.2:61000",
    protocol: "udp",
    rttMs: 43,
    bytesSent: 2048,
    bytesReceived: 4096,
  });
  assert.equal(s, "relay(203.0.113.7:3478) ⇄ srflx(198.51.100.2:61000) udp rtt=43ms ↑2KiB ↓4KiB");
});

test("describePair omits what the browser did not report", () => {
  const s = describePair({
    localType: "host",
    localAddr: "192.168.1.5:9",
    remoteType: "host",
    remoteAddr: "192.168.1.9:9",
    protocol: "udp",
  });
  assert.equal(s, "host(192.168.1.5:9) ⇄ host(192.168.1.9:9) udp");
  // Byte counters render only as a pair -- one alone is not a transfer line.
  assert.ok(
    !describePair({
      localType: "host",
      localAddr: "a:1",
      remoteType: "host",
      remoteAddr: "b:2",
      protocol: "tcp",
      bytesSent: 1024,
    }).includes("KiB"),
  );
});
