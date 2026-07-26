// Tests for the per-device WebRTC transport prefs: the stored-value
// normalizer, the ICE policy resolution (server force_relay wins) and the
// candidate filters the knobs drive. Runs under `node test.mjs`.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  DEFAULT_NET_PREFS,
  candidateTypeOf,
  iceTransportPolicyFor,
  isIPv6CandidateStr,
  normalizeNetPrefs,
  shouldDropCandidate,
  type NetPrefs,
} from "./net-prefs";

const RELAY_V4 = "candidate:1 1 udp 2130706431 46.62.175.213 51596 typ relay";
const HOST_V4 = "candidate:1 1 udp 2122260223 192.168.1.20 63560 typ host";
const HOST_ULA = "candidate:2 1 udp 2122260223 fdb2:2c26:f4e4::1 63561 typ host";
const SRFLX_V6 = "candidate:3 1 udp 1686052607 2a01:4f9:c015:e187::1 9000 typ srflx";

function prefs(patch: Partial<NetPrefs> = {}): NetPrefs {
  return { ...DEFAULT_NET_PREFS, ...patch };
}

test("defaults are every knob off -- browser + server behaviour untouched", () => {
  assert.deepEqual(DEFAULT_NET_PREFS, { transport: "auto", ipv4Only: false, noHost: false });
});

test("normalizeNetPrefs: garbage falls back to the defaults", () => {
  assert.deepEqual(normalizeNetPrefs(null), DEFAULT_NET_PREFS);
  assert.deepEqual(normalizeNetPrefs("relay"), DEFAULT_NET_PREFS);
  assert.deepEqual(normalizeNetPrefs([]), DEFAULT_NET_PREFS);
  assert.deepEqual(normalizeNetPrefs({ transport: "nonsense", ipv4Only: 1 }), DEFAULT_NET_PREFS);
});

test("normalizeNetPrefs: keeps the valid fields of a partial value", () => {
  assert.deepEqual(normalizeNetPrefs({ transport: "relay", noHost: true }), {
    transport: "relay",
    ipv4Only: false,
    noHost: true,
  });
});

test("iceTransportPolicyFor: auto follows the server", () => {
  assert.equal(iceTransportPolicyFor(prefs(), false), "all");
  assert.equal(iceTransportPolicyFor(prefs(), true), "relay");
});

test("iceTransportPolicyFor: the device can force relay, never relax it", () => {
  assert.equal(iceTransportPolicyFor(prefs({ transport: "relay" }), false), "relay");
  assert.equal(iceTransportPolicyFor(prefs({ transport: "auto" }), true), "relay");
});

test("candidateTypeOf reads the typ token", () => {
  assert.equal(candidateTypeOf(RELAY_V4), "relay");
  assert.equal(candidateTypeOf(HOST_V4), "host");
  assert.equal(candidateTypeOf(""), "?");
});

test("isIPv6CandidateStr looks at the address token", () => {
  assert.equal(isIPv6CandidateStr(RELAY_V4), false);
  assert.equal(isIPv6CandidateStr(HOST_ULA), true);
  assert.equal(isIPv6CandidateStr(SRFLX_V6), true);
  assert.equal(isIPv6CandidateStr(""), false);
});

test("shouldDropCandidate: knobs off drops nothing", () => {
  for (const c of [RELAY_V4, HOST_V4, HOST_ULA, SRFLX_V6]) {
    assert.equal(shouldDropCandidate(c, prefs()), false);
  }
});

test("shouldDropCandidate: ipv4Only drops every IPv6 path", () => {
  const p = prefs({ ipv4Only: true });
  assert.equal(shouldDropCandidate(HOST_ULA, p), true);
  assert.equal(shouldDropCandidate(SRFLX_V6, p), true);
  assert.equal(shouldDropCandidate(RELAY_V4, p), false);
  assert.equal(shouldDropCandidate(HOST_V4, p), false);
});

test("shouldDropCandidate: noHost drops only host candidates", () => {
  const p = prefs({ noHost: true });
  assert.equal(shouldDropCandidate(HOST_V4, p), true);
  assert.equal(shouldDropCandidate(HOST_ULA, p), true);
  assert.equal(shouldDropCandidate(SRFLX_V6, p), false);
  assert.equal(shouldDropCandidate(RELAY_V4, p), false);
});

test("shouldDropCandidate: the end-of-candidates marker always survives", () => {
  assert.equal(shouldDropCandidate("", prefs({ ipv4Only: true, noHost: true })), false);
});
