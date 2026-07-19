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
import { VoiceCall } from "../voice/call";

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

      {phase === "in-call" && (
        <div class="chalk-voice-tiles">
          {localStream && camOn && (
            <VideoTile stream={localStream} label="you" muted mirrored />
          )}
          {tileList.map((t) => (
            <RemoteMedia key={t.key} tile={t} label={handleFor(t.userID)} />
          ))}
          {tileList.length === 0 && (
            <div class="chalk-voice-note">nobody else here yet</div>
          )}
        </div>
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
