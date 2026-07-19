// VoiceCallPanel (Phase 30, slices 30-5 + 30-5c): the in-room view of THE
// voice session.
//
// 30-5c moved call OWNERSHIP to the app-level voiceSession singleton (the
// Discord behavior: the call survives browsing; VoiceDock carries audio and
// the connection bar everywhere). This panel is now a pure VIEW:
//
//   * it renders the 30-5 stage (big tile + filmstrip, click-to-pin focus,
//     roster-driven "connecting…" honesty, control bar, debug drawer) when
//     the session is in THIS channel
//   * when the session is in a DIFFERENT room, it says so and offers the
//     lobby (joining here moves you -- one call at a time)
//   * unmount does NOT leave; lifecycle edges (WS loss, removal, logout)
//     are app-level session events
//   * NO audio elements here -- remote audio is rendered exactly once, in
//     VoiceDock; duplicating it would double the output
//
// Click-to-join (Addendum C "click-to-join voice rooms", core) lives in
// App's sidebar onSelect; the lobby buttons remain for the camera variant,
// for retry after errors, and for servers where auto-join is not possible
// (channel key not ready at click time).

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ChannelSummary, VoiceParticipant } from "../state/types";
import type { WSClient } from "../ws-client";
import type { ChannelCrypto } from "../crypto/channel-crypto";
import { voiceSession, type SessionRemoteTile } from "../voice/session";
import { useVoiceSession } from "./VoiceDock";
import { ChannelGlyph } from "./Sidebar";
import type { VoiceDiagnostics } from "../voice/call";

/** Stats refresh cadence while the drawer is open. Passive getStats reads
 * only (the Addendum D rule: nothing in-call may compete with media). */
const DEBUG_STATS_INTERVAL_MS = 2_000;

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

/**
 * describeJoinError (30-6): map the server's voice error codes (the request
 * rejection arrives as "code: message") to actionable phrasing. Unknown
 * codes pass through untouched.
 */
function describeJoinError(raw: string): string {
  if (raw.startsWith("voice_room_full")) {
    return "room is full (server participant cap) — try again when someone leaves";
  }
  if (raw.startsWith("voice_disabled")) {
    return "voice is disabled on this server (CHALK_VOICE_ENABLED)";
  }
  if (raw.startsWith("voice_device_conflict")) {
    return "you are already in this room from another device — leave there first";
  }
  return raw;
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
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
  const snap = useVoiceSession();
  // 30-5 stage focus: null = automatic; a key = user-pinned. View-local --
  // pinning is a "what am I looking at" concern, not call state.
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(0);
  const [debugOpen, setDebugOpen] = useState(false);
  const [diag, setDiag] = useState<VoiceDiagnostics | null>(null);
  const [copied, setCopied] = useState(false);

  const selfKey = selfUserID + ":" + selfDeviceID;
  const hereInCall = snap.phase === "in-call" && snap.channelID === channel.id;
  const hereJoining = snap.phase === "joining" && snap.channelID === channel.id;
  const elsewhere = snap.phase !== "idle" && snap.channelID !== channel.id;

  const handleFor = (userID: string): string => {
    if (userID === selfUserID) return "you";
    const m = (channel.members ?? []).find((x) => x.userID === userID);
    return m?.handle || userID.slice(0, 8);
  };

  const rosterFor = (userID: string, deviceID: string): VoiceParticipant | undefined =>
    roster.find((p) => p.userID === userID && p.deviceID === deviceID);

  // Duration ticker while viewing the live room.
  useEffect(() => {
    if (!hereInCall) return;
    const id = window.setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [hereInCall]);

  // Debug drawer poll: the 30-4c diagnostics blob (per-peer selected-pair
  // stats + the event ring) refreshed while open. Passive getStats reads
  // only (the Addendum D rule: nothing in-call may compete with media).
  useEffect(() => {
    if (!debugOpen || !hereInCall) return;
    let live = true;
    const poll = () => {
      void voiceSession.diagnostics().then((d) => {
        if (live) setDiag(d);
      });
    };
    poll();
    const id = window.setInterval(poll, DEBUG_STATS_INTERVAL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [debugOpen, hereInCall]);

  const join = (withVideo: boolean) =>
    void voiceSession.join({
      channelID: channel.id,
      channelName: channel.name,
      selfUserID,
      selfDeviceID,
      withVideo,
      client,
      cc,
    });

  const toggleCam = () => {
    if (!voiceSession.toggleCam()) {
      // joined audio-only: adding a camera mid-call needs renegotiation (30-7).
      voiceSession.clearError();
      // Surface through the session error slot so it renders consistently.
      // (Direct set: the session exposes no setter; reuse join-error styling.)
      setLocalNote("joined without a camera — leave and rejoin with camera to share video");
    }
  };
  const [localNote, setLocalNote] = useState<string | null>(null);
  useEffect(() => setLocalNote(null), [hereInCall, channel.id]);

  const copyDiagnostics = async () => {
    const blob = await voiceSession.diagnostics();
    const report = {
      generatedAt: new Date().toISOString(),
      channelName: channel.name,
      phase: snap.phase,
      durationMs: snap.joinedAt ? Date.now() - snap.joinedAt : 0,
      roster,
      ...(blob ?? { channelID: channel.id, self: selfKey }),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setLocalNote("clipboard write failed — copy from the console instead");
      console.log("[chalk voice diagnostics]", report);
    }
  };

  // ---- stage model (30-5) --------------------------------------------------
  //
  // One entry per participant the ROSTER says is in the room (self included),
  // enriched with a media stream when the mesh has delivered one. A roster
  // entry without a stream renders as "connecting…" -- the honest state.

  interface StageTile {
    key: string;
    userID: string;
    deviceID: string;
    isSelf: boolean;
    stream: MediaStream | null;
    hasLiveVideo: boolean;
    connState: string | null;
    part?: VoiceParticipant;
  }

  const stageTiles: StageTile[] = useMemo(() => {
    if (!hereInCall) return [];
    const out: StageTile[] = [];
    const seen = new Set<string>();
    // Self first (stable slot in the strip).
    out.push({
      key: selfKey,
      userID: selfUserID,
      deviceID: selfDeviceID,
      isSelf: true,
      stream: snap.localStream,
      hasLiveVideo:
        snap.camOn &&
        !!snap.localStream &&
        snap.localStream.getVideoTracks().some((t) => t.enabled && t.readyState === "live"),
      connState: null,
      part: rosterFor(selfUserID, selfDeviceID),
    });
    seen.add(selfKey);
    for (const p of roster) {
      const key = p.userID + ":" + p.deviceID;
      if (seen.has(key)) continue;
      seen.add(key);
      const t: SessionRemoteTile | undefined = snap.tiles[key];
      out.push({
        key,
        userID: p.userID,
        deviceID: p.deviceID,
        isSelf: false,
        stream: t?.stream ?? null,
        hasLiveVideo:
          !!t && t.stream.getVideoTracks().some((x) => x.readyState === "live"),
        connState: t?.connState ?? "connecting",
        part: p,
      });
    }
    // A peer with media but (momentarily) missing from the roster -- push
    // races. Show it rather than dropping video-with-no-tile on the floor.
    for (const t of Object.values(snap.tiles)) {
      if (seen.has(t.key)) continue;
      out.push({
        key: t.key,
        userID: t.userID,
        deviceID: t.deviceID,
        isSelf: false,
        stream: t.stream,
        hasLiveVideo: t.stream.getVideoTracks().some((x) => x.readyState === "live"),
        connState: t.connState,
      });
    }
    return out;
    // nowTick keeps hasLiveVideo honest as tracks start/stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hereInCall, roster, snap.tiles, snap.localStream, snap.camOn, nowTick]);

  const focusedKey: string | null = useMemo(() => {
    if (stageTiles.length === 0) return null;
    if (pinnedKey && stageTiles.some((t) => t.key === pinnedKey)) return pinnedKey;
    const remoteVideo = stageTiles.find((t) => !t.isSelf && t.hasLiveVideo);
    if (remoteVideo) return remoteVideo.key;
    const remote = stageTiles.find((t) => !t.isSelf);
    if (remote) return remote.key;
    return stageTiles[0].key;
  }, [stageTiles, pinnedKey]);

  const focused = stageTiles.find((t) => t.key === focusedKey) ?? null;
  const strip = stageTiles.filter((t) => t.key !== focusedKey);

  // ---- render --------------------------------------------------------------

  const duration = snap.joinedAt ? fmtDuration(Date.now() - snap.joinedAt) : "00:00";
  void nowTick; // consumed by duration + stage recompute
  const error = snap.error ?? localNote;

  return (
    <div class="chalk-voice-panel chalk-voice-panel--v5" data-testid="voice-panel">
      {!hereInCall ? (
        <div class="chalk-voice-lobby">
          {elsewhere && (
            <span class="chalk-voice-note" data-testid="voice-elsewhere">
              connected to{" "}
              <span class="chalk-chglyph chalk-chglyph--voice">
                <ChannelGlyph type="voice" />
              </span>
              {snap.channelName || "another room"} — joining here moves you
            </span>
          )}
          <button
            class="chalk-btn chalk-voice-joinbtn"
            disabled={hereJoining || !keyReady}
            onClick={() => join(false)}
            data-testid="voice-join"
          >
            {hereJoining ? "joining…" : "join voice"}
          </button>
          <button
            class="chalk-btn chalk-voice-joinbtn"
            disabled={hereJoining || !keyReady}
            onClick={() => join(true)}
            data-testid="voice-join-video"
          >
            join with camera
          </button>
          {!keyReady && <span class="chalk-voice-note">waiting for channel key…</span>}
          {roster.length === 0 && keyReady && !elsewhere && (
            <span class="chalk-voice-note">nobody in here yet — be the first</span>
          )}
        </div>
      ) : (
        <>
          <div class="chalk-voice-stage" data-testid="voice-stage">
            {focused && (
              <div class="chalk-voice-big">
                <StagePeer
                  tile={focused}
                  label={handleFor(focused.userID)}
                  big
                  onClick={() => setPinnedKey(null)}
                />
              </div>
            )}
            {strip.length > 0 && (
              <div class="chalk-voice-strip" data-testid="voice-strip">
                {strip.map((t) => (
                  <StagePeer
                    key={t.key}
                    tile={t}
                    label={handleFor(t.userID)}
                    onClick={() => setPinnedKey(t.key)}
                  />
                ))}
              </div>
            )}
          </div>

          <div class="chalk-voice-bar" data-testid="voice-bar">
            <span class="chalk-voice-duration" data-testid="voice-duration" title="call duration">
              {duration}
            </span>
            {snap.relayOnly && (
              <span
                class="chalk-voice-relay"
                title="iceTransportPolicy=relay (CHALK_VOICE_FORCE_RELAY)"
              >
                relay-only
              </span>
            )}
            <span class="chalk-voice-bar-spacer" />
            <button
              class={"chalk-btn chalk-voice-ctl" + (snap.muted ? " chalk-voice-ctl--off" : "")}
              onClick={() => voiceSession.toggleMute()}
              data-testid="voice-mute"
              title={snap.muted ? "unmute microphone" : "mute microphone"}
            >
              {snap.muted ? "unmute" : "mute"}
            </button>
            <button
              class={"chalk-btn chalk-voice-ctl" + (!snap.camOn ? " chalk-voice-ctl--off" : "")}
              onClick={toggleCam}
              data-testid="voice-cam"
              title={snap.camOn ? "turn camera off" : "turn camera on"}
            >
              {snap.camOn ? "cam off" : "cam on"}
            </button>
            <button
              class={"chalk-btn chalk-voice-ctl" + (debugOpen ? " chalk-voice-ctl--on" : "")}
              onClick={() => setDebugOpen((v) => !v)}
              data-testid="voice-debug-toggle"
              title="signaling + transport diagnostics"
            >
              debug
            </button>
            <button
              class="chalk-btn chalk-voice-ctl chalk-voice-ctl--leave"
              onClick={() => void voiceSession.leave()}
              data-testid="voice-leave"
            >
              leave
            </button>
          </div>

          {debugOpen && (
            <div class="chalk-voice-drawer" data-testid="voice-debug-drawer">
              <div class="chalk-voice-drawer-head">
                <span class="chalk-voice-drawer-title">diagnostics</span>
                <button class="chalk-btn chalk-voice-ctl" onClick={() => void copyDiagnostics()}>
                  {copied ? "copied ✓" : "copy report"}
                </button>
              </div>
              <div class="chalk-voice-drawer-stats">
                {(!diag || diag.peers.length === 0) && (
                  <div class="chalk-voice-note">no live peer connections</div>
                )}
                {diag?.peers.map((p) => (
                  <div class="chalk-voice-drawer-pair" key={p.key}>
                    <span class="chalk-voice-drawer-peer">
                      {handleFor(p.key.split(":")[0])}
                    </span>{" "}
                    {p.connectionState}/{p.iceConnectionState}
                    {p.pair && (
                      <>
                        {" · "}
                        {p.pair.localType}
                        {p.pair.localAddr ? `(${p.pair.localAddr})` : ""} ⇄ {p.pair.remoteType}
                        {p.pair.remoteAddr ? `(${p.pair.remoteAddr})` : ""}
                        {" · "}
                        {p.pair.protocol}
                        {p.pair.rttMs !== undefined && ` · rtt ${p.pair.rttMs}ms`}
                        {p.pair.availableOutgoingKbps !== undefined &&
                          ` · out≈${p.pair.availableOutgoingKbps}kbps`}
                        {p.pair.bytesSent !== undefined && p.pair.bytesReceived !== undefined && (
                          <>
                            {" · "}↑{Math.round(p.pair.bytesSent / 1024)}KiB ↓
                            {Math.round(p.pair.bytesReceived / 1024)}KiB
                          </>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div class="chalk-voice-drawer-events" data-testid="voice-debug-events">
                {(!diag || diag.events.length === 0) && (
                  <div class="chalk-voice-note">no events yet</div>
                )}
                {diag?.events
                  .slice()
                  .reverse()
                  .map((e) => (
                    <div class="chalk-voice-drawer-event" key={e.t + e.msg}>
                      <span class="chalk-voice-drawer-time">
                        {new Date(e.t).toTimeString().slice(0, 8)}
                      </span>{" "}
                      {e.msg}
                    </div>
                  ))}
              </div>
              <div class="chalk-voice-drawer-hint">
                deep inspection: open <code>chrome://webrtc-internals</code> (or{" "}
                <code>brave://webrtc-internals</code>) in a new tab
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <div class="chalk-voice-error" data-testid="voice-error">
          {describeJoinError(error)}
        </div>
      )}
    </div>
  );

  // StagePeer stays inside the component body so it can use handleFor
  // without prop-drilling. NO AudioSink here (VoiceDock owns audio).
  function StagePeer({
    tile,
    label,
    big,
    onClick,
  }: {
    tile: StageTile;
    label: string;
    big?: boolean;
    onClick?: () => void;
  }) {
    return (
      <div
        class={
          "chalk-voice-peer" +
          (big ? " chalk-voice-peer--big" : " chalk-voice-peer--strip") +
          (tile.isSelf ? " chalk-voice-peer--self" : "")
        }
        data-testid={big ? "voice-tile-big" : "voice-tile"}
        data-peer={tile.key}
        onClick={onClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClick();
                }
              }
            : undefined
        }
        title={big ? label : `${label} — click to focus`}
      >
        {tile.hasLiveVideo && tile.stream ? (
          <VideoSurface stream={tile.stream} mirrored={tile.isSelf} />
        ) : (
          <div class="chalk-voice-avatar" aria-hidden="true">
            {(label === "you" ? handleForSelfInitial() : label).slice(0, 1).toUpperCase()}
          </div>
        )}
        <div class="chalk-voice-peer-label">
          <span class="chalk-voice-peer-name">{label}</span>
          {tile.part?.muted && <span class="chalk-voice-peer-flag" title="muted">m</span>}
          {tile.part?.videoOn && <span class="chalk-voice-peer-flag" title="camera on">c</span>}
          {tile.part?.screenOn && (
            <span class="chalk-voice-peer-flag" title="sharing screen">s</span>
          )}
          {!tile.isSelf && tile.connState && tile.connState !== "connected" && (
            <span class="chalk-voice-peer-conn">{tile.connState}…</span>
          )}
        </div>
      </div>
    );
  }

  function handleForSelfInitial(): string {
    const m = (channel.members ?? []).find((x) => x.userID === selfUserID);
    return m?.handle || "y";
  }
}

function VideoSurface({ stream, mirrored }: { stream: MediaStream; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  // ALWAYS muted: remote audio flows exclusively through VoiceDock's sinks
  // (one output path), and self-video must never loop back the mic.
  return (
    <video
      ref={ref}
      class={"chalk-voice-video" + (mirrored ? " chalk-voice-video-mirrored" : "")}
      autoPlay
      playsInline
      muted
    />
  );
}

