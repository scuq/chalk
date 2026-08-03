// GuestRoom (80-13): the guest's whole chalk. One ephemeral voice room:
// the live call plus its scratchpad, nothing else -- no roster, no
// settings, no panels. Deliberately NOT the App in a trench coat: the App's
// boot path is session/identity/prefs machinery a guest doesn't have, so
// this screen reuses the LOW-LEVEL modules directly:
//
//   * WSClient          -- the guest cookie authorizes the upgrade (80-9)
//   * spacekey.ts       -- encrypt/decrypt under the unwrapped space key
//   * voice/call.ts     -- the real mesh, signals sealed under the same key,
//                          DTLS fingerprints signed by the derived Ed25519
//                          identity, exactly like a member's call
//
// The server-side frame allowlist mirrors what this screen sends; adding a
// frame here means opening it there (guest_ws.go), deliberately in review.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  Frame,
  TypeListChannels,
  TypeFetchHistory,
  TypeSend,
  TypeMarkRead,
  TypeMessage,
  TypeMessageDeleted,
  TypeVoicePurged,
  TypeVoiceSignal,
  TypeVoiceParticipantJoined,
  TypeVoiceParticipantLeft,
  TypeVoiceParticipantState,
  type ChannelSummaryWire,
  type ListChannelsAckPayload,
  type FetchHistoryPayload,
  type FetchHistoryAckPayload,
  type MessagePayload,
  type MessageDeletedPayload,
  type SendPayload,
  type MarkReadPayload,
} from "../proto";
import { WSClient, type ConnectionState } from "../ws-client";
import { encryptMessage, decryptMessage } from "../crypto/spacekey";
import type { DerivedIdentity } from "../crypto/identity";
import { VoiceCall, describeMediaError } from "../voice/call";

/** Everything JoinScreen resolved for this guest session. */
export interface GuestContext {
  guestUserID: string;
  displayName: string;
  channelID: string;
  channelName: string;
  channelExpiresAt: number; // unix-millis
  keyVersion: number;
  spaceKey: Uint8Array;
  identity: DerivedIdentity;
}

interface RoomMessage {
  id: string;
  seq: number;
  senderUserID: string;
  text: string;
  ts: number;
  deleted: boolean;
}

interface PeerTile {
  key: string;
  userID: string;
  stream: MediaStream;
  hasVideo: boolean;
}

// One guest = one device, remembered per guest id so a rejoin (same link)
// keeps its voice-mesh identity; two different links in one browser get
// distinct devices instead of fighting over one row.
function guestDeviceID(guestUserID: string): string {
  const key = "chalk_guest_device:" + guestUserID;
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function fmtRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ${mins % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

export function GuestRoom({ ctx }: { ctx: GuestContext }) {
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(Date.now());
  const [inCall, setInCall] = useState(false);
  const [joiningCall, setJoiningCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [peers, setPeers] = useState<PeerTile[]>([]);
  const [callError, setCallError] = useState<string | null>(null);
  const [roomGone, setRoomGone] = useState(false);

  const clientRef = useRef<WSClient | null>(null);
  const callRef = useRef<VoiceCall | null>(null);
  const deviceID = useRef(guestDeviceID(ctx.guestUserID)).current;
  const listRef = useRef<HTMLDivElement | null>(null);

  const expired = now >= ctx.channelExpiresAt;

  // Coarse expiry tick: minute granularity is all the header needs.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const decryptBody = async (body: string, keyVersion?: number): Promise<string> => {
    if (!keyVersion || keyVersion !== ctx.keyVersion) return "[message from before you joined]";
    try {
      const pt = await decryptMessage(ctx.spaceKey, ctx.channelID, keyVersion, b64ToBytes(body));
      return pt ? new TextDecoder().decode(pt) : "[could not decrypt]";
    } catch {
      return "[could not decrypt]";
    }
  };

  const appendWire = async (w: MessagePayload) => {
    if (w.channel_id !== ctx.channelID) return;
    const text = w.body ? await decryptBody(w.body, w.key_version) : "";
    setMessages((prev) => {
      if (prev.some((m) => m.id === w.id)) return prev;
      const next = [...prev, {
        id: w.id,
        seq: w.seq,
        senderUserID: w.sender_user_id ?? "",
        text,
        ts: w.ts,
        deleted: !!w.deleted,
      }];
      next.sort((a, b) => a.seq - b.seq);
      return next;
    });
  };

  // WS lifecycle: connect once, bootstrap on every (re)welcome.
  useEffect(() => {
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const client = new WSClient({
      url: `${wsProto}//${window.location.host}/ws`,
      deviceId: deviceID,
      deviceType: "desktop",
      onState: (s, detail) => {
        setConn(s);
        // The server closes guest conns with a policy reason when the room
        // or session is gone; treat any terminal close after expiry as gone.
        if (s === "closed" && detail && /expired|session|guests/.test(detail)) {
          setRoomGone(true);
        }
      },
      onWelcome: () => {
        void (async () => {
          try {
            const list = await client.request<Record<string, never>, ListChannelsAckPayload>(TypeListChannels, {});
            const ch: ChannelSummaryWire | undefined = (list.channels ?? [])[0];
            if (!ch) {
              setRoomGone(true);
              return;
            }
            const nm: Record<string, string> = {};
            for (const m of ch.members ?? []) nm[m.user_id] = m.handle || "guest";
            setNames(nm);
            const hist = await client.request<FetchHistoryPayload, FetchHistoryAckPayload>(TypeFetchHistory, {
              channel_id: ctx.channelID,
              limit: 200,
            });
            for (const w of [...(hist.messages ?? [])].reverse()) await appendWire(w);
            // Everything visible is read; guests have no unread machinery.
            const top = (hist.messages ?? [])[0];
            if (top) client.send<MarkReadPayload>(TypeMarkRead, { channel_id: ctx.channelID, seq: top.seq });
          } catch (e) {
            console.warn("guest bootstrap:", e);
          }
        })();
      },
      onFrame: (f: Frame) => {
        switch (f.type) {
          case TypeMessage:
            void appendWire(f.payload as MessagePayload);
            break;
          case TypeMessageDeleted: {
            const p = f.payload as MessageDeletedPayload;
            setMessages((prev) => prev.map((m) => (m.id === p.message_id ? { ...m, deleted: true, text: "" } : m)));
            break;
          }
          case TypeVoicePurged:
            // The call emptied; the scratchpad was hard-deleted server-side.
            setMessages([]);
            break;
          case TypeVoiceSignal:
          case TypeVoiceParticipantJoined:
          case TypeVoiceParticipantLeft:
          case TypeVoiceParticipantState:
            callRef.current?.handleFrame(f);
            break;
          default:
            // Server pushes we don't model (typing, reads, ...) are noise here.
            break;
        }
      },
    });
    clientRef.current = client;
    client.start();
    return () => {
      void callRef.current?.leave();
      client.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pin the scratchpad to the newest message.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const sendDraft = async () => {
    const text = draft.trim();
    const c = clientRef.current;
    if (!text || !c || !c.isOpen() || expired) return;
    setDraft("");
    const body = await encryptMessage(ctx.spaceKey, ctx.channelID, ctx.keyVersion, new TextEncoder().encode(text));
    c.send<SendPayload>(TypeSend, {
      channel_id: ctx.channelID,
      body: bytesToB64(body),
      key_version: ctx.keyVersion,
      client_msg_id: crypto.randomUUID(),
    }, "gsend-" + Date.now());
  };

  const joinCall = async () => {
    const c = clientRef.current;
    if (!c || !c.isOpen() || callRef.current || expired) return;
    setCallError(null);
    setJoiningCall(true);
    const call = new VoiceCall({
      channelID: ctx.channelID,
      selfUserID: ctx.guestUserID,
      selfDeviceID: deviceID,
      transport: c,
      crypto: {
        // The guest holds exactly one space key; seal/open under it with the
        // same framing members use (signal-crypto expects the message shape).
        encryptBytesForChannel: async (channelID, bytes) => ({
          kind: "encrypted" as const,
          ciphertext: await encryptMessage(ctx.spaceKey, channelID, ctx.keyVersion, bytes),
          keyVersion: ctx.keyVersion,
        }),
        decryptBytesForChannel: async (channelID, keyVersion, ciphertext) =>
          keyVersion === ctx.keyVersion
            ? decryptMessage(ctx.spaceKey, channelID, keyVersion, ciphertext)
            : null,
      },
      ed25519Private: ctx.identity.ed25519Private,
      startWithVideo: false,
      callbacks: {
        onPeerStream: (key, userID, _deviceID, stream) => {
          setPeers((prev) => [
            ...prev.filter((p) => p.key !== key),
            { key, userID, stream, hasVideo: stream.getVideoTracks().length > 0 },
          ]);
        },
        onPeerGone: (key) => setPeers((prev) => prev.filter((p) => p.key !== key)),
        onPeerState: () => {},
        onLocalStream: () => {},
        onLocalScreenStream: () => {},
        onPeerScreenStream: (key, userID, _deviceID, stream) => {
          setPeers((prev) => [
            ...prev.filter((p) => p.key !== key + ":screen"),
            { key: key + ":screen", userID, stream, hasVideo: true },
          ]);
        },
        onPeerScreenGone: (key) => setPeers((prev) => prev.filter((p) => p.key !== key + ":screen")),
        onError: (msg) => setCallError(msg),
      },
    });
    callRef.current = call;
    try {
      await call.join();
      setInCall(true);
    } catch (e) {
      callRef.current = null;
      setCallError(
        e instanceof DOMException ? describeMediaError("microphone", e) : e instanceof Error ? e.message : "could not join the call",
      );
    } finally {
      setJoiningCall(false);
    }
  };

  const leaveCall = async () => {
    const call = callRef.current;
    callRef.current = null;
    setInCall(false);
    setPeers([]);
    await call?.leave();
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    callRef.current?.setMuted(next);
  };

  if (roomGone || expired) {
    return (
      <div class="chalk-auth" data-testid="guest-room-gone">
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h1>chalk</h1>
          </header>
          <p class="chalk-auth-subtitle">
            this room has ended. Everything in it — messages included — has
            been deleted. You can close this tab.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div class="chalk-guest" data-testid="guest-room">
      <header class="chalk-guest-header">
        <span class="chalk-guest-title">{ctx.channelName}</span>
        <span class="chalk-guest-expiry" data-testid="guest-expiry">
          disappears in {fmtRemaining(ctx.channelExpiresAt - now)}
        </span>
        <span class="chalk-guest-conn">{conn === "open" ? `you are ${ctx.displayName}` : conn}</span>
      </header>

      <div class="chalk-guest-call">
        {!inCall ? (
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            data-testid="guest-join-call"
            onClick={() => void joinCall()}
            disabled={joiningCall || conn !== "open"}
          >
            {joiningCall ? "joining…" : "join the call"}
          </button>
        ) : (
          <div class="chalk-guest-call-controls">
            <button type="button" class="chalk-button chalk-button--secondary" onClick={toggleMute} data-testid="guest-mute">
              {muted ? "unmute" : "mute"}
            </button>
            <button type="button" class="chalk-button chalk-button--secondary" onClick={() => void leaveCall()} data-testid="guest-leave-call">
              leave call
            </button>
          </div>
        )}
        {callError && <div class="chalk-modal-error">{callError}</div>}
        <div class="chalk-guest-peers">
          {peers.map((p) =>
            p.hasVideo ? (
              <video
                key={p.key}
                class="chalk-guest-peer-video"
                autoPlay
                playsInline
                ref={(el) => {
                  if (el && el.srcObject !== p.stream) el.srcObject = p.stream;
                }}
              />
            ) : (
              <audio
                key={p.key}
                autoPlay
                ref={(el) => {
                  if (el && el.srcObject !== p.stream) el.srcObject = p.stream;
                }}
              />
            ),
          )}
        </div>
        {inCall && peers.length === 0 && (
          <div class="chalk-field-hint">connected — waiting for the others.</div>
        )}
      </div>

      <div class="chalk-guest-scratch" ref={listRef} data-testid="guest-scratch">
        {messages.length === 0 ? (
          <div class="chalk-field-hint">
            the scratchpad is empty. Notes typed here vanish when the call
            ends.
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} class="chalk-guest-msg">
              <span class="chalk-guest-msg-sender">
                {m.senderUserID === ctx.guestUserID ? ctx.displayName : names[m.senderUserID] || "member"}
              </span>
              <span class="chalk-guest-msg-text">{m.deleted ? "[deleted]" : m.text}</span>
            </div>
          ))
        )}
      </div>

      <form
        class="chalk-guest-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void sendDraft();
        }}
      >
        <input
          type="text"
          class="chalk-field-input"
          data-testid="guest-composer"
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          placeholder="scratchpad — visible to the room, gone when the call ends"
          disabled={conn !== "open"}
        />
        <button type="submit" class="chalk-button chalk-button--primary" disabled={conn !== "open" || !draft.trim()}>
          send
        </button>
      </form>
    </div>
  );
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
