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
  newFrame,
} from "./proto";

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
    const frame = newFrame(type, payload, ref);
    this.ws.send(JSON.stringify(frame));
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    try {
      this.ws = new WebSocket(this.opts.url, [SUBPROTOCOL]);
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
    // Send hello immediately. Server expects it as the first frame; we
    // can't enter "open" until welcome arrives.
    const hello = newFrame<HelloPayload>(TypeHello, {
      device_id: this.opts.deviceId,
      device_type: this.opts.deviceType,
    });
    this.ws.send(JSON.stringify(hello));
  }

  private onMessage(e: MessageEvent): void {
    let frame: Frame;
    try {
      frame = JSON.parse(e.data as string) as Frame;
    } catch (err) {
      this.logger.warn("WSClient: bad json:", err, e.data);
      return;
    }
    if (frame.type === TypeWelcome) {
      // Transition to open. Reset backoff -- we're back in business.
      this.backoff = BACKOFF_INITIAL_MS;
      this.setState("open");
      this.opts.onWelcome(frame.payload as WelcomePayload);
      return;
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
    // hello, account not active. Stop trying.
    if (e.code === 1002 || e.code === 1008) {
      this.stopped = true;
      this.setState("error", `closed (code=${e.code}, reason=${e.reason || "policy"})`);
      return;
    }
    this.setState("closed", `closed (code=${e.code})`);
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
export function getOrCreateDeviceId(): string {
  const existing = window.localStorage.getItem(DEVICE_ID_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) {
    return existing;
  }
  const fresh = crypto.randomUUID();
  window.localStorage.setItem(DEVICE_ID_KEY, fresh);
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
  try {
    window.localStorage.removeItem(DEVICE_ID_KEY);
  } catch {
    // localStorage can throw in private-browsing edge cases; we
    // already tolerate missing-storage in getOrCreateDeviceId by
    // generating a fresh id each call, so a missed clear here is
    // harmless.
  }
}

// Phase 10d: per-user thread-seen state.
//
// Key shape: chalk.threadSeen.<userID> -> JSON map { threadID: seq }.
// Per-user to avoid collisions when multiple accounts use the same
// browser profile.
function threadSeenKey(userID: string): string {
  return "chalk.threadSeen." + userID;
}

export function getThreadSeen(userID: string): Record<string, number> {
  if (!userID) return {};
  try {
    const raw = window.localStorage.getItem(threadSeenKey(userID));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, number> = {};
      for (const k of Object.keys(parsed)) {
        const v = parsed[k];
        if (typeof v === "number" && v > 0) out[k] = v;
      }
      return out;
    }
  } catch {
    /* corrupt: fall through */
  }
  return {};
}

export function setThreadSeen(
  userID: string,
  seen: Record<string, number>,
): void {
  if (!userID) return;
  try {
    window.localStorage.setItem(threadSeenKey(userID), JSON.stringify(seen));
  } catch {
    /* quota or disabled storage: ignore */
  }
}
