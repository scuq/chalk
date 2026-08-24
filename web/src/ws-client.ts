// chalk WS client wrapper.
//
// Responsibilities:
//   * Open a WebSocket against /ws with the chalk.v1 subprotocol
//   * Send hello on connect, await welcome
//   * Emit typed events to subscribers for incoming frames
//   * Reconnect with exponential backoff on transport errors
//   * Generate a stable per-browser device_id (localStorage-backed)
//
// Out of scope for phase 07:
//   * MLS encryption (phase 10)
//   * Per-channel routing (phase 08)
//   * Auth (phase 11; phase 07 trusts the device_id like phase 04 does)
//
// The reconnect logic uses a backoff that starts at 250 ms and doubles
// to a 10 s ceiling, matching the server-side pubsub listener. If the
// server tells us a hard policy violation (bad subprotocol, bad hello),
// we stop reconnecting -- the cause won't fix itself.

import {
  Frame,
  HelloPayload,
  WelcomePayload,
  SUBPROTOCOL,
  TypeHello,
  TypeWelcome,
  TypeInnerHello,
  TypeInnerAck,
  TypeInnerUnavailable,
  type InnerHelloPayload,
  type InnerAckPayload,
  newFrame,
} from "./proto";
// 83-6: the inner sealed channel.
import { startClientHandshake, InnerSession, type ClientHandshake } from "./crypto/innerchan";
import { loadPinnedServerKey, pinServerKey } from "./crypto/server-pin";
import { asBytes } from "./crypto/bytes";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export interface WSClientOptions {
  url: string; // e.g. "ws://localhost:8443/ws"
  deviceId: string;
  deviceType: "phone" | "tablet" | "desktop"; // browser detection done at higher layer
  // onState fires on every transition. UI uses this to render banners.
  onState: (s: ConnectionState, detail?: string) => void;
  // onWelcome fires once per successful (re)connect with the server's welcome.
  onWelcome: (w: WelcomePayload) => void;
  // onFrame fires for every non-welcome inbound frame. Type-switch on f.type.
  onFrame: (f: Frame) => void;
  // logger is optional; defaults to console.
  logger?: { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  // 83-6: onServerPinWall fires when the server proves a DIFFERENT identity
  // than the one this device pinned -- a MITM toward home, or an operator
  // rotation. The connection is refused and not retried; the UI shows the
  // wall (the fingerprint seen vs. pinned) and offers re-pin. Absent = the
  // pin mismatch just closes the socket as a policy error.
  onServerPinWall?: (info: { seenFingerprint: string; pinnedFingerprint: string; seenPub: Uint8Array }) => void;
}

const BACKOFF_INITIAL_MS = 250;
const BACKOFF_MAX_MS = 10_000;

export class WSClient {
  private opts: WSClientOptions;
  private ws: WebSocket | null = null;
  private state: ConnectionState = "closed";
  private backoff = BACKOFF_INITIAL_MS;
  private reconnectTimer: number | null = null;
  private stopped = false;
  private logger: NonNullable<WSClientOptions["logger"]>;
  // 83-6: inner-channel handshake state. `handshake` holds the client half
  // between inner_hello and inner_ack; `session` is set once the channel is
  // sealed. Both reset on every (re)connect.
  private handshake: ClientHandshake | null = null;
  private session: InnerSession | null = null;
  private innerReady = false;
  // Phase 11a: in-flight requests waiting for an ack-by-ref. Populated
  // by request(); drained by onMessage() before onFrame() dispatch.
  private pending: Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }> = new Map();
  private refCounter = 0;

  constructor(opts: WSClientOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? console;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "client stop");
      this.ws = null;
    }
    this.setState("closed", "stopped by caller");
  }

  send<P>(type: string, payload?: P, ref?: string): void {
    if (this.state !== "open" || !this.ws) {
      throw new Error(`WSClient.send called while state=${this.state}`);
    }
    this.writeFrame(newFrame(type, payload, ref));
  }

  // writeFrame serializes a frame and, when the inner channel is sealed,
  // encrypts it (binary) instead of sending plaintext JSON. Async sealing is
  // queued so counters stay strictly ordered even under concurrent sends.
  private writeFrame(frame: Frame): void {
    const json = JSON.stringify(frame);
    if (!this.session) {
      this.ws!.send(json);
      return;
    }
    this.sealQueue = this.sealQueue
      .then(async () => {
        if (!this.session || !this.ws) return;
        const sealed = await this.session.seal(new TextEncoder().encode(json));
        this.ws.send(asBytes(sealed));
      })
      .catch((e) => this.logger.warn("WSClient: seal failed:", e));
  }
  private sealQueue: Promise<void> = Promise.resolve();

  isOpen(): boolean {
    return this.state === "open";
  }

  /**
   * isSealed reports whether the CURRENT connection runs the 83-6 inner
   * sealed channel -- the server proved the pinned identity at handshake and
   * every frame since is sealed. False on a plaintext (keyless dev server)
   * session and while not connected. Read by the 83-9 server-identity card.
   */
  isSealed(): boolean {
    return this.state === "open" && this.session !== null;
  }

  // Phase 11a: request() -- send a frame and resolve with the matching
  // ack's payload. Uses the existing ref-based correlation in send().
  // The returned promise rejects on "error" type acks or when the
  // socket is not open at send time.
  request<P, R = unknown>(type: string, payload?: P): Promise<R> {
    if (!this.isOpen() || !this.ws) {
      return Promise.reject(new Error(`WSClient.request called while state=${this.state}`));
    }
    this.refCounter++;
    const ref = `r${Date.now().toString(36)}-${this.refCounter}`;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(ref, {
        resolve: (v: unknown) => resolve(v as R),
        reject,
      });
      try {
        this.send(type, payload, ref);
      } catch (e) {
        this.pending.delete(ref);
        reject(e);
      }
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    this.handshake = null;
    this.session = null;
    this.innerReady = false;
    this.sealQueue = Promise.resolve();
    this.recvChain = Promise.resolve();
    try {
      this.ws = new WebSocket(this.opts.url, [SUBPROTOCOL]);
      this.ws.binaryType = "arraybuffer";
    } catch (err) {
      this.logger.warn("WSClient: dial threw:", err);
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => this.onOpen();
    this.ws.onmessage = (e) => this.onMessage(e);
    this.ws.onerror = (e) => this.onError(e);
    this.ws.onclose = (e) => this.onClose(e);
  }

  private onOpen(): void {
    if (!this.ws) return;
    if (this.ws.protocol !== SUBPROTOCOL) {
      // Server didn't accept our subprotocol. Hard fail -- the server
      // closes us anyway, but we set state and bail out of reconnect.
      this.logger.warn(`WSClient: subprotocol mismatch, got ${this.ws.protocol}`);
      this.stopped = true;
      this.setState("error", "subprotocol not negotiated");
      this.ws.close(1002, "subprotocol mismatch");
      return;
    }
    // 83-6: negotiate the inner sealed channel BEFORE hello, so hello and
    // everything after travel sealed. inner_hello is plaintext JSON; the
    // server answers inner_ack (or inner_unavailable on a dev stack).
    void this.beginInnerHandshake();
  }

  private async beginInnerHandshake(): Promise<void> {
    try {
      this.handshake = await startClientHandshake();
      const payload: InnerHelloPayload = {
        proto_version: 1,
        client_eph_pub: bytesToB64(this.handshake.hello.clientEphPub),
        client_nonce: bytesToB64(this.handshake.hello.clientNonce),
      };
      if (this.ws && this.state === "connecting") {
        this.ws.send(JSON.stringify(newFrame(TypeInnerHello, payload)));
      }
    } catch (err) {
      this.logger.warn("WSClient: inner handshake start failed:", err);
      this.hardFail("inner handshake failed");
    }
  }

  private sendHello(): void {
    this.innerReady = true;
    this.writeFrame(
      newFrame<HelloPayload>(TypeHello, {
        device_id: this.opts.deviceId,
        device_type: this.opts.deviceType,
      }),
    );
  }

  // Handle inner_ack / inner_unavailable. Returns true if the frame was part
  // of the handshake (consumed here), false to fall through to normal routing.
  private async handleInnerFrame(frame: Frame): Promise<boolean> {
    if (this.innerReady) return false;
    if (frame.type === TypeInnerUnavailable) {
      // Dev stack with no server identity. If we hold a pin, this is a wall:
      // a real MITM would strip the inner channel to run plaintext, and our
      // registered server had one. With no pin, proceed (TOFU'd nothing yet).
      const pinned = await loadPinnedServerKey();
      if (pinned) {
        this.hardFail("server identity unavailable but a pin exists");
        return true;
      }
      this.handshake = null;
      this.sendHello();
      return true;
    }
    if (frame.type === TypeInnerAck && this.handshake) {
      const p = frame.payload as InnerAckPayload;
      let serverEphPub: Uint8Array, serverEdPub: Uint8Array, sig: Uint8Array;
      try {
        serverEphPub = b64ToBytes(p.server_eph_pub);
        serverEdPub = b64ToBytes(p.server_ed25519_pub);
        sig = b64ToBytes(p.sig);
      } catch {
        this.hardFail("malformed inner_ack");
        return true;
      }
      const pinned = await loadPinnedServerKey();
      try {
        // finish() verifies the signature (a MITM cannot re-sign the
        // transcript against the pinned key) THEN, when a pin exists,
        // requires the proven key to equal it. It throws "...not the pinned
        // key" for a valid signature under a different key (the wall) and a
        // different message for an invalid signature (a MITM's own key).
        this.session = await this.handshake.finish(serverEphPub, serverEdPub, sig, pinned);
      } catch (err) {
        this.handshake = null;
        if (pinned && err instanceof Error && err.message.includes("not the pinned key")) {
          // Valid signature, key is not the pin: operator rotation or a MITM
          // that somehow signed a valid transcript (it cannot without the
          // key). Surface both fingerprints so the user can compare + re-pin.
          void this.raiseWall(serverEdPub, pinned);
        } else {
          // Invalid signature: a MITM presenting its own key. No trustworthy
          // comparison to show -- hard failure.
          this.hardFail("server signature did not verify");
        }
        return true;
      }
      this.handshake = null;
      if (!pinned) {
        // First contact after an update (an account that predates phase 83):
        // TOFU the key, stated as such (D.4).
        await pinServerKey(serverEdPub, "tofu");
      }
      this.sendHello();
      return true;
    }
    return false;
  }

  private async raiseWall(seenPub: Uint8Array, pinnedPub: Uint8Array): Promise<void> {
    this.stopped = true;
    const { serverFingerprint } = await import("./crypto/innerchan");
    const info = {
      seenFingerprint: await serverFingerprint(seenPub),
      pinnedFingerprint: await serverFingerprint(pinnedPub),
      seenPub,
    };
    this.setState("error", "server identity changed");
    this.opts.onServerPinWall?.(info);
    // 4003: app-level refusal. A client-initiated close may only use 1000 or
    // 3000-4999 (the 1008 policy code is server-side vocabulary).
    this.ws?.close(4003, "server identity changed");
  }

  private hardFail(detail: string): void {
    this.stopped = true;
    this.setState("error", detail);
    this.ws?.close(4003, detail); // client closes may not use 1008
  }

  private onMessage(e: MessageEvent): void {
    // Third-audit fix: inbound frames are processed on ONE promise chain.
    // Opening a sealed frame awaits WebCrypto, and InnerSession.open checks
    // the counter before that await -- two unserialized opens from a burst
    // of pushes would interleave and read a correct counter as a violation.
    // The chain also keeps dispatch order identical to arrival order.
    this.recvChain = this.recvChain
      .then(() => this.onMessageAsync(e))
      .catch((err) => this.logger.warn("WSClient: frame handling failed:", err));
  }
  private recvChain: Promise<void> = Promise.resolve();

  private async onMessageAsync(e: MessageEvent): Promise<void> {
    let text: string;
    if (typeof e.data === "string") {
      // Plaintext frame: only legal before the session is sealed (the
      // handshake frames) or on an unsealed dev connection.
      text = e.data;
    } else {
      // 83-6: a sealed binary frame. Open it under the session; a counter or
      // authentication violation is a MITM tampering with the stream -- wall.
      if (!this.session) {
        this.logger.warn("WSClient: binary frame before session");
        return;
      }
      try {
        const pt = await this.session.open(new Uint8Array(e.data as ArrayBuffer));
        text = new TextDecoder().decode(pt);
      } catch (err) {
        this.logger.warn("WSClient: inner channel violation:", err);
        this.hardFail("inner channel violation");
        return;
      }
    }
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch (err) {
      this.logger.warn("WSClient: bad json:", err);
      return;
    }
    if (await this.handleInnerFrame(frame)) return;
    if (frame.type === TypeWelcome) {
      // Transition to open. Reset backoff -- we're back in business.
      this.backoff = BACKOFF_INITIAL_MS;
      this.setState("open");
      this.opts.onWelcome(frame.payload as WelcomePayload);
      return;
    }
    // Phase 11a: ref-correlated request/response. If the inbound
    // frame's ref matches one we've registered via request(), settle
    // that promise and DON'T forward to opts.onFrame (the request's
    // initiator owns it). Errors with a known ref reject the promise.
    if (frame.ref) {
      const waiter = this.pending.get(frame.ref);
      if (waiter) {
        this.pending.delete(frame.ref);
        if (frame.type === "error") {
          const ep = frame.payload as { code?: string; message?: string };
          waiter.reject(new Error(`${ep?.code ?? "error"}: ${ep?.message ?? "unknown"}`));
        } else {
          waiter.resolve(frame.payload);
        }
        return;
      }
    }
    this.opts.onFrame(frame);
  }

  private onError(_e: Event): void {
    // onError is followed by onClose. Just log; the close handler
    // decides whether to reconnect.
    this.logger.warn("WSClient: socket error");
  }

  private onClose(e: CloseEvent): void {
    const wasOpen = this.state === "open";
    this.ws = null;
    if (this.stopped) {
      this.setState("closed", `closed (code=${e.code})`);
      return;
    }
    // Codes 1002 (protocol error) and 1008 (policy violation) usually
    // mean the cause won't auto-resolve: wrong subprotocol, malformed
    // hello, account not active. Stop trying. Note the server closes
    // ping timeouts with app code 4008, not 1008, precisely so they
    // fall through to the reconnect path below -- a missed pong is a
    // congested or flaky link (video call chewing the uplink, laptop
    // lid closed), not a reason to give up.
    if (e.code === 1002 || e.code === 1008) {
      this.stopped = true;
      this.setState("error", `closed (code=${e.code}, reason=${e.reason || "policy"})`);
      return;
    }
    // 80-13: carry the server's goodbye text. The guest room matches on it
    // ("room expired") to show its terminal screen instead of reconnecting.
    this.setState("closed", `closed (code=${e.code}${e.reason ? `, reason=${e.reason}` : ""})`);
    if (wasOpen) {
      // Drop straight back to initial backoff so a brief glitch
      // doesn't make us slow to come back.
      this.backoff = BACKOFF_INITIAL_MS;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.logger.log(`WSClient: reconnecting in ${delay}ms`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(s: ConnectionState, detail?: string): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState(s, detail);
  }
}

// getOrCreateDeviceId returns a stable per-browser UUID stored in
// localStorage. Phase 11 will replace this with a passkey-derived
// identity; for now we just need stability across page reloads so the
// server's per-device presence bookkeeping doesn't churn.
const DEVICE_ID_KEY = "chalk.deviceId";

// 48-3: crypto.randomUUID is secure-context-only and missing on older
// WebKit, so a plain-http LAN deploy would crash here before the socket
// ever opened. The fallback only has to be unique across one user's own
// devices, so Math.random is acceptable.
function randomDeviceId(): string {
  return randomUuid();
}

// 83-6: base64 helpers for the inner-handshake frames.
function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * randomUuid returns a canonical v4-shaped uuid string, with the same
 * fallback ladder the device id uses. 83-2: message client_msg_ids come from
 * here too -- the signed envelope encodes them as strict uuid16, so they must
 * be real uuids, not prefixed strings.
 */
export function randomUuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// 48-3: when localStorage itself is unavailable (private browsing with a
// zero quota, storage blocked by policy) the id lives here instead --
// stable for this page load, regenerated on reload. The server tolerates
// the churn via ensureDeviceForUser's rebind path (see below).
let memoryDeviceId: string | null = null;

export function getOrCreateDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId;
  let existing: string | null = null;
  try {
    existing = window.localStorage.getItem(DEVICE_ID_KEY);
  } catch {
    // storage unavailable; fall through to the in-memory id
  }
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) {
    return existing;
  }
  const fresh = randomDeviceId();
  try {
    window.localStorage.setItem(DEVICE_ID_KEY, fresh);
  } catch {
    memoryDeviceId = fresh;
  }
  return fresh;
}

// Phase 9.6f: clearDeviceId removes the persisted device UUID. Called
// on logout so the next sign-in (which may be a different user on the
// same browser) generates a fresh device_id. This prevents the second
// user from inheriting the first user's devices row on the server,
// which would mis-route their friend/presence operations.
//
// The server's ensureDeviceForUser ALSO rebinds the row on conflict
// (see Phase 9.6f server change) as defense in depth, but clearing
// here means the rebind path is rare and the server log line for it
// is genuinely interesting when it fires.
export function clearDeviceId(): void {
  memoryDeviceId = null;
  try {
    window.localStorage.removeItem(DEVICE_ID_KEY);
  } catch {
    // localStorage can throw in private-browsing edge cases; without
    // storage the id was in-memory anyway, and that was cleared above.
  }
}

// Phase 10d's per-user thread-seen localStorage blob lived here until 42-4.
//
// It was replaced, not moved: thread read state is now server-side
// (thread_reads, migration 0047), so it follows the user across devices instead
// of being stranded on whichever browser happened to read the thread. The two
// reasons it had to go:
//
//   * per-device state made the bug worse. Reading a thread on a phone left the
//     badge lit on a laptop forever, with nothing to ever clear it.
//   * it was rewritten IN FULL on every arriving reply -- a synchronous
//     JSON.stringify plus a localStorage write on the main thread, sized by
//     every thread the user had ever opened.
//
// Nothing replaced it on disk. Cursors arrive with the history rows they
// decorate (42-3) and via mark_thread_read/thread_read_state (42-4), both
// bounded by what is on screen.
