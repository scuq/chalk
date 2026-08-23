// Reconnect policy for WSClient.onClose. The regression this pins down:
// the server used to close ping timeouts with 1008 (policy violation),
// which the client treats as permanent -- one congested moment during a
// video call and the tab stayed dead until a manual refresh. Ping
// timeouts now arrive as app code 4008 and must schedule a reconnect;
// genuine policy violations (1008) and protocol errors (1002) must not.

import test from "node:test";
import assert from "node:assert/strict";

import { SUBPROTOCOL, TypeWelcome } from "./proto";

// ---- browser-global mocks ------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  protocol = SUBPROTOCOL; // as if the server negotiated it
  binaryType = "blob";
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;

  constructor(url: string, _protocols?: string[]) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string | ArrayBuffer): void {
    if (typeof data === "string") this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

interface ScheduledTimer {
  fn: () => void;
  delay: number;
}

let scheduled: ScheduledTimer[] = [];

// WSClient only touches window.setTimeout/clearTimeout and the WebSocket
// constructor; stub exactly those.
(globalThis as { window?: unknown }).window = {
  setTimeout: (fn: () => void, delay: number) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  },
  clearTimeout: () => {},
  location: { origin: "http://test" },
};
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;

// Import after the globals exist -- ws-client captures nothing at module
// scope, but keeping the order explicit costs nothing.
const { WSClient } = await import("./ws-client");

type StateEvent = { state: string; detail?: string };

function newClient(states: StateEvent[]) {
  return new WSClient({
    url: "ws://test/ws",
    deviceId: "11111111-1111-4111-8111-111111111111",
    deviceType: "desktop",
    onState: (state, detail) => states.push({ state, detail }),
    onWelcome: () => {},
    onFrame: () => {},
    logger: { log: () => {}, warn: () => {} },
  });
}

// Drive a fresh client to the "open" state: connect, run the 83-6 inner
// handshake (dev-stack path: no server key -> inner_unavailable -> plaintext),
// then welcome. Async because the client mints an X25519 ephemeral before
// sending inner_hello.
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
async function openClient(states: StateEvent[]) {
  const client = newClient(states);
  client.start();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.onopen!();
  await flush(); // inner_hello is sent
  ws.onmessage!({ data: JSON.stringify({ type: "inner_unavailable" }) });
  await flush(); // plaintext hello is sent
  ws.onmessage!({
    data: JSON.stringify({ type: TypeWelcome, payload: { user_id: "u", device_id: "d", handle: "h", channels: [] } }),
  });
  await flush();
  assert.equal(client.isOpen(), true);
  return { client, ws };
}

function reset() {
  scheduled = [];
  FakeWebSocket.instances = [];
}

// ---- the policy ----------------------------------------------------

test("ping timeout (4008) schedules a reconnect", async () => {
  reset();
  const states: StateEvent[] = [];
  const { ws } = await openClient(states);

  ws.onclose!({ code: 4008, reason: "ping timeout" });

  assert.equal(scheduled.length, 1, "expected a reconnect timer");
  // A drop from "open" resets backoff so recovery is fast.
  assert.equal(scheduled[0].delay, 250);
  assert.equal(states[states.length - 1].state, "closed");

  // Firing the timer dials a fresh socket.
  const before = FakeWebSocket.instances.length;
  scheduled[0].fn();
  assert.equal(FakeWebSocket.instances.length, before + 1);
});

test("policy violation (1008) stops for good", async () => {
  reset();
  const states: StateEvent[] = [];
  const { ws } = await openClient(states);

  ws.onclose!({ code: 1008, reason: "session expired" });

  assert.equal(scheduled.length, 0, "must not reconnect on 1008");
  const last = states[states.length - 1];
  assert.equal(last.state, "error");
  assert.match(last.detail ?? "", /session expired/);
});

test("protocol error (1002) stops for good", async () => {
  reset();
  const states: StateEvent[] = [];
  const { ws } = await openClient(states);

  ws.onclose!({ code: 1002, reason: "" });

  assert.equal(scheduled.length, 0, "must not reconnect on 1002");
  assert.equal(states[states.length - 1].state, "error");
});

test("abnormal closure (1006) schedules a reconnect", async () => {
  reset();
  const states: StateEvent[] = [];
  const { ws } = await openClient(states);

  ws.onclose!({ code: 1006, reason: "" });

  assert.equal(scheduled.length, 1, "expected a reconnect timer");
  assert.equal(states[states.length - 1].state, "closed");
});
