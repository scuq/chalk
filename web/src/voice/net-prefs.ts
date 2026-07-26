// chalk-web -- per-device WebRTC transport preferences (the debug drawer knobs).
//
// Which paths a call may use is a property of the machine and the network it
// sits on, not of the account: a laptop behind a UDP-blocking corporate NAT
// wants relay-only, a VM host with a dead IPv6 ULA bridge wants the IPv4-only
// candidate filter, and neither should follow the user to their phone. So:
// localStorage, same shape as mic-prefs.ts, never near the server.
//
// The IPv4-only filter used to be hard-coded on for everyone (it worked around
// one client enumerating a non-routable fdb2:… interface whose TURN host
// lookups failed). That penalised genuinely IPv6-reachable deploys, so it is a
// knob now, off by default.
//
// The pure half (normalizeNetPrefs, iceTransportPolicyFor, shouldDropCandidate
// and the candidate parsers) is unit-tested; the localStorage wrappers are not,
// which is the convention mic-prefs and the display prefs already set.

import { useCallback, useEffect, useState } from "preact/hooks";

/** "auto" follows the server's force_relay; "relay" forces TURN for this device. */
export type TransportMode = "auto" | "relay";

export interface NetPrefs {
  transport: TransportMode;
  /** Drop IPv6 candidates, local and remote. */
  ipv4Only: boolean;
  /** Drop host candidates: no LAN paths, and no local addresses advertised. */
  noHost: boolean;
}

const STORAGE_KEY = "chalk.voice.net.v1";

// Every knob off = exactly what the browser and the server policy would do on
// their own. Someone who never opens the debug drawer is unaffected.
export const DEFAULT_NET_PREFS: NetPrefs = {
  transport: "auto",
  ipv4Only: false,
  noHost: false,
};

export function isTransportMode(v: unknown): v is TransportMode {
  return v === "auto" || v === "relay";
}

/** normalizeNetPrefs fills every field from a possibly-garbage stored value.
 * Total by construction: a throw here would take every voice join down. */
export function normalizeNetPrefs(raw: unknown): NetPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_NET_PREFS };
  const o = raw as Record<string, unknown>;
  return {
    transport: isTransportMode(o.transport) ? o.transport : DEFAULT_NET_PREFS.transport,
    ipv4Only: typeof o.ipv4Only === "boolean" ? o.ipv4Only : DEFAULT_NET_PREFS.ipv4Only,
    noHost: typeof o.noHost === "boolean" ? o.noHost : DEFAULT_NET_PREFS.noHost,
  };
}

/**
 * iceTransportPolicyFor resolves the RTCPeerConnection policy.
 *
 * A deployment that sets force_relay has decided its members must not expose
 * their addresses to each other, so the client can only ever tighten that, not
 * relax it: "auto" means "whatever the server said", never "let me out of it".
 */
export function iceTransportPolicyFor(
  prefs: NetPrefs,
  forceRelay: boolean,
): RTCIceTransportPolicy {
  return forceRelay || prefs.transport === "relay" ? "relay" : "all";
}

// ---- candidate filtering ---------------------------------------------------
//
// A candidate SDP line is:
//   candidate:<foundation> <component> <transport> <priority> <ADDR> <port> typ <type> ...
// so the 5th token is the address and an address containing ':' is IPv6.

/** candidateTypeOf pulls the "typ" token out of a raw candidate line. */
export function candidateTypeOf(candidate: string): string {
  const m = /\styp\s+(\S+)/.exec(candidate);
  return m ? m[1] : "?";
}

export function isIPv6CandidateStr(candidate: string): boolean {
  const addr = candidate.split(/\s+/)[4];
  return !!addr && addr.includes(":");
}

/**
 * shouldDropCandidate reports whether these prefs suppress a candidate. Applied
 * to both halves of the exchange -- ours before we advertise it, the peer's
 * before we pair against it -- because a path is only useful if both ends keep
 * it, and pairing against an unreachable address just burns connectivity checks.
 *
 * The empty line (the end-of-candidates marker) is never dropped: it tells the
 * far end gathering is done.
 */
export function shouldDropCandidate(candidate: string, prefs: NetPrefs): boolean {
  if (!candidate) return false;
  if (prefs.ipv4Only && isIPv6CandidateStr(candidate)) return true;
  if (prefs.noHost && candidateTypeOf(candidate) === "host") return true;
  return false;
}

// ---- storage ---------------------------------------------------------------

export function loadNetPrefs(): NetPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_NET_PREFS };
    return normalizeNetPrefs(JSON.parse(raw));
  } catch {
    // Private-browsing localStorage throws, and a corrupt entry throws in
    // JSON.parse. Neither is worth failing a call over.
    return { ...DEFAULT_NET_PREFS };
  }
}

// Same-tab listeners, for the same reason as mic-prefs.ts: the `storage` event
// deliberately does not fire in the tab that wrote, so it alone would let the
// drawer flip a knob while the live call in that very tab never hears about it.
const listeners = new Set<(prefs: NetPrefs) => void>();

export function saveNetPrefs(prefs: NetPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // The setting just won't survive a reload; listeners still fire, so it
    // holds for this session -- including for the call that's running now.
  }
  for (const fn of listeners) fn(prefs);
}

export function subscribeNetPrefs(onChange: (prefs: NetPrefs) => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange(loadNetPrefs());
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useNetPrefs(): [NetPrefs, (patch: Partial<NetPrefs>) => void] {
  const [prefs, setPrefs] = useState<NetPrefs>(loadNetPrefs);

  const update = useCallback((patch: Partial<NetPrefs>) => {
    setPrefs((prev) => {
      const next = normalizeNetPrefs({ ...prev, ...patch });
      saveNetPrefs(next);
      return next;
    });
  }, []);

  useEffect(() => subscribeNetPrefs(setPrefs), []);

  return [prefs, update];
}
