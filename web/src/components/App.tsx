// chalk top-level component.
//
// Owns the WS client lifecycle, holds the connection state, and
// renders the three child components: StatusBar, MessageList, Composer.
//
// Phase 07's UI is deliberately minimal -- the goal is a working
// shell, not a chat client. Phase 08 introduces channel switching;
// phase 10 introduces MLS-encrypted state above this component.

import { useEffect, useReducer, useRef } from "preact/hooks";
import type { Frame, MessagePayload, WelcomePayload, ErrorPayload } from "../proto";
import {
  TypeMessage,
  TypeSend,
  TypeError,
  type SendPayload,
} from "../proto";
import { WSClient, getOrCreateDeviceId, type ConnectionState } from "../ws-client";
import { StatusBar } from "./StatusBar";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";

interface AppState {
  conn: ConnectionState;
  connDetail: string;
  user: { id: string; device: string } | null;
  messages: MessagePayload[];
  errors: ErrorPayload[];
}

type Action =
  | { kind: "state"; conn: ConnectionState; detail?: string }
  | { kind: "welcome"; user_id: string; device_id: string }
  | { kind: "message"; msg: MessagePayload }
  | { kind: "error"; err: ErrorPayload };

const initialState: AppState = {
  conn: "closed",
  connDetail: "",
  user: null,
  messages: [],
  errors: [],
};

function reduce(s: AppState, a: Action): AppState {
  switch (a.kind) {
    case "state":
      return { ...s, conn: a.conn, connDetail: a.detail ?? "" };
    case "welcome":
      return { ...s, user: { id: a.user_id, device: a.device_id } };
    case "message":
      // Keep at most the last 200 messages in memory. Phase 08 will
      // back the message list with the real store via fetch_history.
      return {
        ...s,
        messages: [...s.messages, a.msg].slice(-200),
      };
    case "error":
      return { ...s, errors: [...s.errors, a.err].slice(-20) };
  }
}

// classifyDevice picks a presence device_type from the user agent.
// Conservative: only "phone" or "tablet" if the UA clearly says so;
// otherwise "desktop". The server treats unrecognized values as
// "browser-unknown" (10-minute TTL); we'd rather be wrong toward
// desktop than risk being marked offline mid-call.
function classifyDevice(): "phone" | "tablet" | "desktop" {
  const ua = navigator.userAgent;
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android.*Mobile|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return "phone";
  return "desktop";
}

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const clientRef = useRef<WSClient | null>(null);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws`;
    const client = new WSClient({
      url,
      deviceId: getOrCreateDeviceId(),
      deviceType: classifyDevice(),
      onState: (conn, detail) => dispatch({ kind: "state", conn, detail }),
      onWelcome: (w: WelcomePayload) =>
        dispatch({ kind: "welcome", user_id: w.user_id, device_id: w.device_id }),
      onFrame: (f: Frame) => {
        switch (f.type) {
          case TypeMessage:
            dispatch({ kind: "message", msg: f.payload as MessagePayload });
            break;
          case TypeError:
            dispatch({ kind: "error", err: f.payload as ErrorPayload });
            break;
          // Phase 07 ignores presence/friend frames; later phases
          // grow new dispatch cases here.
          default:
            break;
        }
      },
    });
    clientRef.current = client;
    client.start();
    return () => client.stop();
  }, []);

  const onSend = (body: string) => {
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    const payload: SendPayload = { body };
    c.send(TypeSend, payload);
  };

  return (
    <div class="chalk-app">
      <header class="chalk-header">
        <h1>chalk</h1>
        <StatusBar state={state.conn} detail={state.connDetail} user={state.user} />
      </header>
      <main class="chalk-main">
        <MessageList messages={state.messages} ownDevice={state.user?.device ?? null} />
      </main>
      <footer class="chalk-footer">
        <Composer disabled={state.conn !== "open"} onSend={onSend} />
        {state.errors.length > 0 && (
          <div class="chalk-errors" role="status">
            {state.errors.slice(-1).map((e) => (
              <div key={`${e.code}-${e.message}`}>
                <span class="chalk-error-code">{e.code}</span> {e.message}
              </div>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}
