// chalk -- 83-6: the inner sealed channel, browser side.
//
// Mirror of internal/innerchan (Go). Frozen in PHASE-83-MSGSIG.md D.3:
//
//   client -> server : client_eph_pub(32) || client_nonce(32)
//   server -> client : server_eph_pub(32) || server_ed25519_pub(32) || sig64
//   transcript_hash  = SHA-256(u8(1) || client_eph || server_eph
//                       || client_nonce || server_ed25519_pub)
//   sig64            = Ed25519(server key, "chalk-server-id.v1" || transcript_hash)
//   K_c2s / K_s2c    = HKDF-SHA256(X25519 ss, salt "chalk-inner-salt-v1",
//                       info "chalk-inner-{c2s,s2c}-v1" || transcript_hash)
//   frame            = u64be(counter) || AES-256-GCM(K_dir,
//                       nonce = u32be(0) || u64be(counter), plaintext)
//
// Counters start at 1, strictly increase per direction, and a repeated or
// out-of-order counter is a protocol violation: the caller closes the
// socket. The known-answer test (innerchan.test.ts) asserts this file and
// the Go package produce identical bytes from identical inputs.
//
// WHY THE CLIENT VERIFIES BEFORE DERIVING. The signature is what binds the
// server's ephemeral to the identity the client pinned; deriving keys from
// an unverified transcript would let a TLS-terminating MITM with its own
// ephemeral finish the handshake. Verify, compare to the pin, THEN derive.

import { asBytes, type Bytes } from "./bytes";

const PROTO_VERSION = 1;
const SIG_DOMAIN = new TextEncoder().encode("chalk-server-id.v1");
const HKDF_SALT = new TextEncoder().encode("chalk-inner-salt-v1");
const INFO_C2S = new TextEncoder().encode("chalk-inner-c2s-v1");
const INFO_S2C = new TextEncoder().encode("chalk-inner-s2c-v1");
const COUNTER_MAX = 2n ** 64n - 1n;

export interface ClientHello {
  clientEphPub: Uint8Array; // 32
  clientNonce: Uint8Array; // 32
}

/** One direction's sealed channel state. */
export class InnerSession {
  private sendCtr = 0n; // client -> server
  private recvCtr = 0n; // server -> client
  constructor(
    private readonly c2s: CryptoKey,
    private readonly s2c: CryptoKey,
  ) {}

  /** seal one outbound frame: u64be(counter) || gcm(K_c2s). */
  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.sendCtr >= COUNTER_MAX) throw new Error("innerchan: counter exhausted");
    this.sendCtr++;
    const ctr = u64be(this.sendCtr);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceFor(ctr) }, this.c2s, asBytes(plaintext)),
    );
    const out = new Uint8Array(8 + ct.length);
    out.set(ctr, 0);
    out.set(ct, 8);
    return out;
  }

  /**
   * open one inbound frame. Throws on a repeated / out-of-order counter or
   * a frame that does not authenticate -- the caller MUST close the socket.
   */
  async open(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.length < 8 + 16) throw new Error("innerchan: short frame");
    const ctr = readU64be(frame.subarray(0, 8));
    if (ctr !== this.recvCtr + 1n) throw new Error("innerchan: repeated or out-of-order counter");
    let pt: ArrayBuffer;
    try {
      pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonceFor(frame.subarray(0, 8)) },
        this.s2c,
        asBytes(frame.subarray(8)),
      );
    } catch {
      throw new Error("innerchan: frame does not authenticate");
    }
    this.recvCtr = ctr;
    return new Uint8Array(pt);
  }
}

/** ClientHandshake holds the client's half until the server answers. */
export interface ClientHandshake {
  hello: ClientHello;
  /** finish verifies the server's answer against `expectedServerEdPub` (the
   *  pin; null on first contact = TOFU) and derives the session. Throws on
   *  a bad signature or a key that is not the pin. */
  finish(serverEphPub: Uint8Array, serverEdPub: Uint8Array, sig: Uint8Array, expectedServerEdPub: Uint8Array | null): Promise<InnerSession>;
}

/**
 * startClientHandshake mints the ephemeral X25519 key and nonce. The private
 * half never leaves the closure. `ephSeed` is for the known-answer test
 * only (a fixed scalar); production callers pass nothing.
 */
export async function startClientHandshake(test?: { ephSeed: Uint8Array; nonce: Uint8Array }): Promise<ClientHandshake> {
  let priv: CryptoKey;
  let clientEphPub: Uint8Array;
  if (test) {
    priv = await crypto.subtle.importKey("pkcs8", pkcs8X25519(test.ephSeed), { name: "X25519" }, false, ["deriveBits"]);
    const bp = await crypto.subtle.importKey("raw", X25519_BASEPOINT, { name: "X25519" }, false, []);
    clientEphPub = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: bp }, priv, 256));
  } else {
    const kp = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    priv = kp.privateKey;
    clientEphPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const clientNonce = test ? test.nonce : crypto.getRandomValues(new Uint8Array(32));
  return {
    hello: { clientEphPub, clientNonce },
    async finish(serverEphPub, serverEdPub, sig, expectedServerEdPub) {
      if (serverEphPub.length !== 32 || serverEdPub.length !== 32 || sig.length !== 64) {
        throw new Error("innerchan: malformed server handshake");
      }
      const th = await transcriptHash(clientEphPub, serverEphPub, clientNonce, serverEdPub);
      if (!(await verifyServerSignature(serverEdPub, th, sig))) {
        throw new Error("innerchan: server signature does not verify");
      }
      if (expectedServerEdPub && !bytesEqual(expectedServerEdPub, serverEdPub)) {
        throw new Error("innerchan: server key is not the pinned key");
      }
      const peer = await crypto.subtle.importKey("raw", asBytes(serverEphPub), { name: "X25519" }, false, []);
      const ss = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, priv, 256));
      return deriveSession(ss, th);
    },
  };
}

export async function transcriptHash(
  clientEph: Uint8Array,
  serverEph: Uint8Array,
  clientNonce: Uint8Array,
  serverEdPub: Uint8Array,
): Promise<Uint8Array> {
  const buf = new Uint8Array(1 + 32 * 4);
  buf[0] = PROTO_VERSION;
  buf.set(clientEph, 1);
  buf.set(serverEph, 33);
  buf.set(clientNonce, 65);
  buf.set(serverEdPub, 97);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

export async function verifyServerSignature(serverEdPub: Uint8Array, th: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", asBytes(serverEdPub), { name: "Ed25519" }, false, ["verify"]);
    const msg = new Uint8Array(SIG_DOMAIN.length + th.length);
    msg.set(SIG_DOMAIN, 0);
    msg.set(th, SIG_DOMAIN.length);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, asBytes(sig), msg);
  } catch {
    return false;
  }
}

export async function deriveSession(ss: Uint8Array, th: Uint8Array): Promise<InnerSession> {
  const base = await crypto.subtle.importKey("raw", asBytes(ss), "HKDF", false, ["deriveKey"]);
  const mk = (info: Uint8Array, usage: KeyUsage) => {
    const full = new Uint8Array(info.length + th.length);
    full.set(info, 0);
    full.set(th, info.length);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: full },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      [usage],
    );
  };
  return new InnerSession(await mk(INFO_C2S, "encrypt"), await mk(INFO_S2C, "decrypt"));
}

/**
 * serverFingerprint renders a server public key the way chalkctl prints it:
 * hex SHA-256 of the raw key, first 128 bits, grouped in fours.
 */
export async function serverFingerprint(pub: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", asBytes(pub))).subarray(0, 16);
  const hex = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{4}/g)!.join(" ");
}

// ---- internals -----------------------------------------------------------

function nonceFor(ctr: Uint8Array): Bytes {
  const n = new Uint8Array(12);
  n.set(ctr, 4);
  return n;
}

function u64be(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n);
  return b;
}

function readU64be(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const X25519_BASEPOINT = (() => {
  const bp = new Uint8Array(32);
  bp[0] = 9;
  return bp;
})();
const PKCS8_X25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);
function pkcs8X25519(scalar: Uint8Array): Bytes {
  const out = new Uint8Array(PKCS8_X25519_PREFIX.length + 32);
  out.set(PKCS8_X25519_PREFIX, 0);
  out.set(scalar, PKCS8_X25519_PREFIX.length);
  return out;
}
