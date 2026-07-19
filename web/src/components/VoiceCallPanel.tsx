// VoiceCallPanel (Phase 30, slice 30-4): the MINIMAL in-call surface that
// makes the mesh testable -- join/leave, mute, camera toggle, remote tiles,
// live roster, relay badge. Deliberately plain: 30-5 delivers the
// Discord-style sidebar occupancy + tile layout; this panel exists so the
// §7d acceptance gate (relay-only call between two browsers) has a UI.
//
// Ownership: the panel owns one VoiceCall instance for the channel it is
// mounted on. App routes voice frames onto voiceBus; the panel forwards them
// to the manager. Unmount (channel switch, logout) leaves the room -- v1 has
// no background calls.

import { useEffect, useRef, useState } from "preact/hooks";
import type { ChannelSummary, VoiceParticipant } from "../state/types";
import type { WSClient } from "../ws-client";
import type { ChannelCrypto } from "../crypto/channel-crypto";
import { loadIdentity } from "../crypto/idb";
import { voiceBus } from "../voice/bus";
import { VoiceCall, type VoicePeerDiag, type VoiceDiagnostics } from "../voice/call";

interface RemoteTile {
  key: string;
  userID: string;
  deviceID: string;
  stream: MediaStream;
  connState: string;
}

interface Props {
  channel: ChannelSummary;
  selfUserID: string;
  selfDeviceID: string;
  /** Live refs from App -- read .current at call time (reconnect-safe). */
  client: { current: WSClient | null };
  cc: { current: ChannelCrypto | null };
  /** Reducer-owned occupancy for this channel (joined/left/state pushes). */
  roster: VoiceParticipant[];
  /** Composer-style gate: signaling needs the channel space key. */
  keyReady: boolean;
}

export function VoiceCallPanel({
  channel,
  selfUserID,
  selfDeviceID,
  client,
  cc,
  roster,
  keyReady,
}: Props) {
  const callRef = useRef<VoiceCall | null>(null);
  const [phase, setPhase] = useState<"idle" | "joining" | "in-call">("idle");
  const [error, setError] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Record<string, RemoteTile>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [withVideo, setWithVideo] = useState(false);
  const [relayOnly, setRelayOnly] = useState(false);
  // 30-4c: diagnostics drawer (ICE/TURN troubleshooting for every user, not
  // just console readers). Stats poll only while the drawer is open.
  const [debugOpen, setDebugOpen] = useState(false);
  const [diag, setDiag] = useState<VoiceDiagnostics | null>(null);
  const [copied, setCopied] = useState(false);

  const handleFor = (userID: string): string => {
    if (userID === selfUserID) return "you";
    const m = (channel.members ?? []).find((x) => x.userID === userID);
    return m?.handle || userID.slice(0, 8);
  };

  // Route voice frames from App onto the live call. Subscribed for the
  // panel's lifetime; the manager itself filters by channel + self.
  useEffect(() => {
    const unsub = voiceBus.subscribe((f) => callRef.current?.handleFrame(f));
    return unsub;
  }, []);

  // Leaving by unmount: channel switch / logout tears the call down.
  useEffect(() => {
    return () => {
      void callRef.current?.leave();
      callRef.current = null;
    };
  }, [channel.id]);

  // 30-4c: poll diagnostics every 2s while the drawer is open and a call
  // exists. Cheap: bounded event ring + one getStats() per peer per tick.
  useEffect(() => {
    if (!debugOpen) return undefined;
    let cancelled = false;
    const tick = async () => {
      const d = await callRef.current?.diagnostics();
      if (!cancelled && d) setDiag(d);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [debugOpen, phase]);

  const copyDiagnostics = async () => {
    const d = await callRef.current?.diagnostics();
    if (!d) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(d, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("clipboard write failed — copy from the drawer instead");
    }
  };

  const join = async () => {
    if (phase !== "idle") return;
    const ws = client.current;
    const crypto_ = cc.current;
    if (!ws || !ws.isOpen() || !crypto_) {
      setError("not connected");
      return;
    }
    setError(null);
    setPhase("joining");
    try {
      const ident = await loadIdentity(selfUserID);
      if (!ident) throw new Error("no local identity — complete identity setup first");
      const call = new VoiceCall({
        channelID: channel.id,
        selfUserID,
        selfDeviceID,
        transport: {
          request: (t, p) => client.current!.request(t, p),
          send: (t, p, r) => client.current!.send(t, p, r),
          isOpen: () => client.current?.isOpen() ?? false,
        },
        crypto: crypto_,
        ed25519Private: ident.ed25519Private,
        callbacks: {
          onPeerStream: (key, userID, deviceID, stream) =>
            setTiles((s) => ({
              ...s,
              [key]: { key, userID, deviceID, stream, connState: s[key]?.connState ?? "connecting" },
            })),
          onPeerGone: (key) =>
            setTiles((s) => {
              const { [key]: _gone, ...rest } = s;
              return rest;
            }),
          onPeerState: (key, state) =>
            setTiles((s) => (s[key] ? { ...s, [key]: { ...s[key], connState: state } } : s)),
          onLocalStream: (stream) => setLocalStream(stream),
          onError: (msg) => setError(msg),
        },
      });
      callRef.current = call;
      await call.join(withVideo);
      setRelayOnly(call.relayOnly);
      setCamOn(call.joinedWithVideo);
      setMuted(false);
      setPhase("in-call");
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      void callRef.current?.leave();
      callRef.current = null;
      setPhase("idle");
    }
  };

  const leave = async () => {
    const call = callRef.current;
    callRef.current = null;
    setPhase("idle");
    setTiles({});
    setRelayOnly(false);
    if (call) await call.leave();
  };

  const toggleMute = () => {
    const call = callRef.current;
    if (!call) return;
    const next = !muted;
    call.setMuted(next);
    setMuted(next);
  };

  const toggleCam = () => {
    const call = callRef.current;
    if (!call) return;
    if (!call.joinedWithVideo) {
      setError("joined without a camera — leave and rejoin with camera to share video");
      return;
    }
    const next = !camOn;
    if (call.setVideoEnabled(next)) setCamOn(next);
  };

  const tileList = Object.values(tiles);
  return (
    <div class="chalk-voice-panel" data-testid="voice-panel">
      <div class="chalk-voice-controls">
        {phase !== "in-call" ? (
          <>
            <button
              class="chalk-btn"
              disabled={phase === "joining" || !keyReady}
              onClick={() => void join()}
              data-testid="voice-join"
            >
              {phase === "joining" ? "joining…" : "Join voice"}
            </button>
            <label class="chalk-voice-camopt">
              <input
                type="checkbox"
                checked={withVideo}
                onChange={(e) => setWithVideo((e.target as HTMLInputElement).checked)}
              />{" "}
              with camera
            </label>
            {!keyReady && <span class="chalk-voice-note">waiting for channel key…</span>}
          </>
        ) : (
          <>
            <button class="chalk-btn" onClick={() => void leave()} data-testid="voice-leave">
              Leave
            </button>
            <button class="chalk-btn" onClick={toggleMute}>
              {muted ? "Unmute" : "Mute"}
            </button>
            <button class="chalk-btn" onClick={toggleCam}>
              {camOn ? "Camera off" : "Camera on"}
            </button>
            {relayOnly && (
              <span class="chalk-voice-relay" title="iceTransportPolicy=relay (CHALK_VOICE_FORCE_RELAY)">
                relay-only
              </span>
            )}
            <button
              class="chalk-voice-debug-btn"
              onClick={() => setDebugOpen((v) => !v)}
              title="connection diagnostics (ICE/TURN)"
              data-testid="voice-debug"
            >
              debug
            </button>
          </>
        )}
      </div>

      {error && <div class="chalk-voice-error">{error}</div>}

      {roster.length > 0 && (
        <div class="chalk-voice-roster" data-testid="voice-roster">
          {roster.map((p) => (
            <span class="chalk-voice-occupant" key={p.userID + ":" + p.deviceID}>
              {handleFor(p.userID)}
              {p.muted ? " 🔇" : ""}
              {p.videoOn ? " 🎥" : ""}
            </span>
          ))}
        </div>
      )}

      {phase === "in-call" && (() => {
        // Honest tiles: a roster occupant without a media stream yet renders
        // as "connecting to X…" -- "nobody else here yet" ONLY when the room
        // is genuinely just us. (The old unconditional text was misleading
        // whenever peers were present but media hadn't connected.)
        const others = roster.filter(
          (p) => !(p.userID === selfUserID && p.deviceID === selfDeviceID),
        );
        const pending = others.filter(
          (p) => !tiles[p.userID + ":" + p.deviceID],
        );
        return (
          <div class="chalk-voice-tiles">
            {localStream && camOn && (
              <VideoTile stream={localStream} label="you" muted mirrored />
            )}
            {tileList.map((t) => (
              <RemoteMedia key={t.key} tile={t} label={handleFor(t.userID)} />
            ))}
            {pending.map((p) => (
              <div class="chalk-voice-note" key={"pend-" + p.userID + p.deviceID}>
                connecting to {handleFor(p.userID)}…
              </div>
            ))}
            {others.length === 0 && (
              <div class="chalk-voice-note">nobody else here yet</div>
            )}
          </div>
        );
      })()}

      {debugOpen && (
        <VoiceDebugDrawer
          diag={diag}
          copied={copied}
          onCopy={() => void copyDiagnostics()}
          handleFor={handleFor}
        />
      )}
    </div>
  );
}

// RemoteMedia renders a peer: always a hidden autoplay <audio> (sound must
// flow even without video), plus a <video> tile when the stream carries a
// live video track.
function RemoteMedia({ tile, label }: { tile: RemoteTile; label: string }) {
  const hasVideo = tile.stream.getVideoTracks().length > 0;
  return (
    <div class="chalk-voice-tile">
      <AudioSink stream={tile.stream} />
      {hasVideo ? (
        <VideoTile stream={tile.stream} label={label} />
      ) : (
        <div class="chalk-voice-audioonly">{label}</div>
      )}
      <div class="chalk-voice-tile-state">
        {label} · {tile.connState}
      </div>
    </div>
  );
}

function AudioSink({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  return <audio ref={ref} autoPlay style={{ display: "none" }} />;
}

function VideoTile({
  stream,
  label,
  muted,
  mirrored,
}: {
  stream: MediaStream;
  label: string;
  muted?: boolean;
  mirrored?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <video
      ref={ref}
      class={"chalk-voice-video" + (mirrored ? " chalk-voice-video-mirrored" : "")}
      autoPlay
      playsInline
      muted={!!muted}
      title={label}
    />
  );
}

// ---- 30-4c: diagnostics drawer ----------------------------------------------
//
// Renders the VoiceCall's structured event ring + live getStats() snapshots
// so ANY user can troubleshoot ICE/TURN without opening the console, and can
// hand a complete bug report over with one click ("copy diagnostics").
// webrtc-internals is referenced as copyable text: browsers refuse to
// navigate to chrome:// / brave:// URLs from page links by design.

function fmtBytes(n?: number): string {
  if (n === undefined) return "-";
  if (n > 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n > 1024) return (n / 1024).toFixed(1) + " kB";
  return n + " B";
}

function PeerDiagRow({ p, label }: { p: VoicePeerDiag; label: string }) {
  return (
    <div class="chalk-voice-diag-peer">
      <div>
        <b>{label}</b> · conn={p.connectionState} ice={p.iceConnectionState} gather=
        {p.iceGatheringState} signaling={p.signalingState}
      </div>
      {p.pair ? (
        <div>
          pair: {p.pair.localType} {p.pair.localAddr} ⇄ {p.pair.remoteType}{" "}
          {p.pair.remoteAddr} ({p.pair.protocol})
          {p.pair.rttMs !== undefined && <> · rtt {p.pair.rttMs}ms</>}
          {" · "}↑{fmtBytes(p.pair.bytesSent)} ↓{fmtBytes(p.pair.bytesReceived)}
          {p.pair.availableOutgoingKbps !== undefined && (
            <> · uplink ~{p.pair.availableOutgoingKbps} kbps</>
          )}
        </div>
      ) : (
        <div>no selected candidate pair yet (ICE not connected)</div>
      )}
    </div>
  );
}

function VoiceDebugDrawer({
  diag,
  copied,
  onCopy,
  handleFor,
}: {
  diag: VoiceDiagnostics | null;
  copied: boolean;
  onCopy: () => void;
  handleFor: (userID: string) => string;
}) {
  if (!diag) {
    return <div class="chalk-voice-diag">collecting diagnostics…</div>;
  }
  return (
    <div class="chalk-voice-diag" data-testid="voice-diag">
      <div class="chalk-voice-diag-head">
        <span>
          relay-only={String(diag.forceRelay)} · ice: {diag.iceServerURLs.join(", ") || "(none)"}
        </span>
        <button class="chalk-voice-debug-btn" onClick={onCopy}>
          {copied ? "copied ✓" : "copy diagnostics"}
        </button>
      </div>
      <div class="chalk-voice-diag-hint">
        deep inspection: open <code>chrome://webrtc-internals</code> (Brave:{" "}
        <code>brave://webrtc-internals</code>) in a new tab — internal pages can't be
        linked from here.
      </div>
      {diag.peers.length === 0 && <div>no peer connections</div>}
      {diag.peers.map((p) => (
        <PeerDiagRow key={p.key} p={p} label={handleFor(p.key.split(":")[0] ?? "")} />
      ))}
      <div class="chalk-voice-diag-events">
        {diag.events.map((e, i) => (
          <div key={i}>
            {new Date(e.t).toLocaleTimeString()} {e.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
