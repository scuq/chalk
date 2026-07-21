// Tests for the IPv4-only candidate filter helpers in call.ts. Some clients
// enumerate a non-routable IPv6 ULA interface (e.g. fdb2:... from a VM/VPN
// bridge) whose TURN/STUN host lookups fail; ipv4Only drops IPv6 candidates so
// the working IPv4 relay path is used. Runs under `node test.mjs`.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { isIPv6Candidate, isIPv6CandidateInit } from "./call";

// A minimal RTCIceCandidate-like stub; the helper only reads .candidate.
function cand(s: string): RTCIceCandidate {
  return { candidate: s } as RTCIceCandidate;
}

test("isIPv6Candidate: IPv4 relay candidate -> false", () => {
  assert.equal(
    isIPv6Candidate(cand("candidate:1 1 udp 2130706431 46.62.175.213 51596 typ relay")),
    false,
  );
});

test("isIPv6Candidate: IPv6 ULA host candidate -> true", () => {
  assert.equal(
    isIPv6Candidate(cand("candidate:2 1 udp 2122260223 fdb2:2c26:f4e4::1 63561 typ host")),
    true,
  );
});

test("isIPv6Candidate: full IPv6 address -> true", () => {
  assert.equal(
    isIPv6Candidate(cand("candidate:3 1 udp 2122260223 2a01:4f9:c015:e187::1 9000 typ host")),
    true,
  );
});

test("isIPv6Candidate: empty string -> false", () => {
  assert.equal(isIPv6Candidate(cand("")), false);
});

test("isIPv6CandidateInit: reads the init shape", () => {
  assert.equal(
    isIPv6CandidateInit({ candidate: "candidate:1 1 udp 1 10.0.0.5 5000 typ host" }),
    false,
  );
  assert.equal(
    isIPv6CandidateInit({ candidate: "candidate:1 1 udp 1 fe80::1 5000 typ host" }),
    true,
  );
});

test("isIPv6CandidateInit: missing candidate field -> false", () => {
  assert.equal(isIPv6CandidateInit({} as RTCIceCandidateInit), false);
});
