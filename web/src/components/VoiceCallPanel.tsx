// VoiceCallPanel (Phase 30, slices 30-5 + 30-5c): the in-room view of THE
// voice session.
//
// 30-5c moved call OWNERSHIP to the app-level voiceSession singleton (the
// Discord behavior: the call survives browsing; VoiceDock carries audio and
// the connection bar everywhere). This panel is now a pure VIEW:
//
//   * it renders the 30-5 stage (big tile + filmstrip, click-to-pin focus,
//     roster-driven "connecting…" honesty, control bar, debug drawer) when
//     the session is in THIS channel -- or, for group calls of three or
//     more (63-1), a grid of identical tiles (voice/grid.ts); a live screen
//     share brings the spotlight back, as does clicking a grid tile, and
//     96-2's control-bar toggle overrides the lot
//   * when the session is in a DIFFERENT room, it says so and offers the
//     lobby (joining here moves you -- one call at a time)
//   * unmount does NOT leave; lifecycle edges (WS loss, removal, logout)
//     are app-level session events
//   * NO audio elements here -- remote audio is rendered exactly once, in
//     VoiceDock; duplicating it would double the output
//
// Click-to-join (Addendum C "click-to-join voice rooms", core) lives in an
// App-level effect keyed off keyStatus, triggered by the sidebar's onSelect
// dispatching set_active_channel; it fires whether the channel key was
// already ready (revisit) or becomes ready asynchronously (first visit), so
// both cases auto-join -- but only once per selection, so hanging up while
// still viewing the room stays hung up. The lobby buttons remain for the
// camera variant, for retry after errors, and to rejoin after leaving
// without switching channels first.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ChannelSummary, VoiceParticipant } from "../state/types";
import type { WSClient } from "../ws-client";
import type { ChannelCrypto } from "../crypto/channel-crypto";
import {
  voiceSession,
  type SessionRemoteTile,
  type ScreenShareMode,
  type VoiceSessionSnap,
} from "../voice/session";
import { useVoiceSession } from "./VoiceDock";
import { ChannelGlyph } from "./Sidebar";
import type { VoiceDiagnostics } from "../voice/call";
import { useNetPrefs } from "../voice/net-prefs";
import {
  closeTilePopout,
  openTilePopout,
  popoutKeys,
  subscribePopouts,
  syncTilePopouts,
} from "../voice/pip";
import { gridPlan, isCrowded, resolveGridMode, type VoiceLayout } from "../voice/grid";

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
  /** 66-5: round-trip time in the corner of each remote tile (prefs.voice). */
  showLatency: boolean;
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

// 66-5: where a round trip stops being invisible and where it starts costing
// you the conversation. Round numbers on purpose -- the badge is a traffic
// light, not a measurement, and the debug drawer is there for the real figure.
const RTT_WARN_MS = 150;
const RTT_BAD_MS = 300;

function rttSeverityClass(ms: number): string {
  if (ms >= RTT_BAD_MS) return " chalk-voice-rtt--bad";
  if (ms >= RTT_WARN_MS) return " chalk-voice-rtt--warn";
  return "";
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
  showLatency,
}: Props) {
  const snap = useVoiceSession();
  // 30-5 stage focus: null = automatic; a key = user-pinned. View-local --
  // pinning is a "what am I looking at" concern, not call state.
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  // 96-1: grid vs spotlight. "auto" is the 63-1 rule; the bar's toggle and a
  // click on a grid tile record a standing choice. View-local and per visit:
  // it is about this stage, not about the account.
  const [layout, setLayout] = useState<VoiceLayout>("auto");
  const [nowTick, setNowTick] = useState(0);
  const [debugOpen, setDebugOpen] = useState(false);
  // 45-5: the tile blown up in the in-app expanded view -- the fallback for
  // engines without document PiP. Held by KEY, not by value: the tile is
  // re-resolved from the stage every render, so a stream swap or a peer
  // leaving can't leave a frozen copy on screen.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Tiles currently showing in windows of their own. Owned by the pip module,
  // not by this panel: a pop-out outlives the panel (browse to a text channel
  // and this unmounts), so the panel only mirrors the module's set.
  const [popped, setPopped] = useState<string[]>(() => popoutKeys());
  const [diag, setDiag] = useState<VoiceDiagnostics | null>(null);
  const [copied, setCopied] = useState(false);
  // Per-device transport knobs. Saving pushes them into the live call (the
  // session subscribes for as long as a call runs).
  const [net, setNet] = useNetPrefs();

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
  //
  // 66-5: the latency overlay reads the same blob on the same timer -- one
  // poll, whichever of the two wants it. The rest of the blob (a bounded
  // event ring, a handful of numbers) costs nothing next to the getStats
  // call both need anyway.
  useEffect(() => {
    if ((!debugOpen && !showLatency) || !hereInCall) return;
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
  }, [debugOpen, showLatency, hereInCall]);

  // 66-5: peer key -> last measured round trip. Absent while the first poll is
  // in flight, and for a peer whose pair has no rtt yet -- the badge is simply
  // not drawn, which is more honest than a zero.
  const rttByKey = useMemo(() => {
    const out: Record<string, number> = {};
    if (!showLatency) return out;
    for (const p of diag?.peers ?? []) {
      if (typeof p.pair?.rttMs === "number") out[p.key] = p.pair.rttMs;
    }
    return out;
  }, [showLatency, diag]);

  const join = () =>
    void voiceSession.join({
      channelID: channel.id,
      channelName: channel.name,
      selfUserID,
      selfDeviceID,
      client,
      cc,
    });

  // A transport change only reaches peers that connect after it (a browser
  // reads iceTransportPolicy while gathering). Leaving and rejoining rebuilds
  // every peer connection, which is the honest way to apply it to a live room.
  const rejoin = async () => {
    await voiceSession.leave();
    join();
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
    // 30-7a screen tiles: one extra tile per active share (self + remote),
    // keyed "<peer>:screen" so pinning distinguishes it from the camera.
    if (snap.localScreenStream) {
      out.push({
        key: selfKey + ":screen",
        userID: selfUserID,
        deviceID: selfDeviceID,
        isSelf: true,
        stream: snap.localScreenStream,
        hasLiveVideo: snap.localScreenStream
          .getVideoTracks()
          .some((x) => x.readyState === "live"),
        connState: null,
        isScreen: true,
      });
    }
    for (const t of Object.values(snap.tiles)) {
      if (!t.screenStream) continue;
      // 30-7b (B5): a locally hidden share renders as the placeholder tile
      // (avatar + "show") and never wins the auto-focus.
      const hidden = !!snap.screenHidden[t.key];
      out.push({
        key: t.key + ":screen",
        userID: t.userID,
        deviceID: t.deviceID,
        isSelf: false,
        stream: t.screenStream,
        hasLiveVideo:
          !hidden && t.screenStream.getVideoTracks().some((x) => x.readyState === "live"),
        // 96-3: only a share that actually carries program audio gets the
        // volume controls -- most don't, and a dead slider is a lie. Tracks
        // can be added mid-share, which the nowTick recompute picks up.
        hasAudio: t.screenStream.getAudioTracks().length > 0,
        connState: null,
        isScreen: true,
      });
    }
    return out;
    // nowTick keeps hasLiveVideo honest as tracks start/stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hereInCall, roster, snap.tiles, snap.localStream, snap.localScreenStream, snap.screenHidden, snap.camOn, nowTick]);

  const focusedKey: string | null = useMemo(() => {
    if (stageTiles.length === 0) return null;
    if (pinnedKey && stageTiles.some((t) => t.key === pinnedKey)) return pinnedKey;
    // 30-7a (B5): a screen share is the primary tile -- remote first.
    const screen =
      stageTiles.find((t) => t.isScreen && !t.isSelf && t.hasLiveVideo) ??
      stageTiles.find((t) => t.isScreen && t.hasLiveVideo);
    if (screen) return screen.key;
    const remoteVideo = stageTiles.find((t) => !t.isSelf && t.hasLiveVideo);
    if (remoteVideo) return remoteVideo.key;
    const remote = stageTiles.find((t) => !t.isSelf);
    if (remote) return remote.key;
    return stageTiles[0].key;
  }, [stageTiles, pinnedKey]);

  const focused = stageTiles.find((t) => t.key === focusedKey) ?? null;
  const strip = stageTiles.filter((t) => t.key !== focusedKey);

  // 63-1: group calls render as a grid of identical tiles. The spotlight
  // stays for 1:1 and while a share is live -- unless the viewer has said
  // otherwise with the bar's toggle (96-1).
  const hasLiveShare = stageTiles.some((t) => t.isScreen && t.hasLiveVideo);
  const gridMode = resolveGridMode(layout, stageTiles.length, hasLiveShare);
  const grid = gridPlan(stageTiles.length);

  // Leaving the grid is a layout decision, so clicking a grid tile records
  // one: pin it AND stand the spotlight up. Clicking the big tile puts that
  // back -- but only when there is a pin to release, so a spotlight chosen
  // with the toggle is not undone by a click on the tile it is showing.
  const pinFromGrid = (key: string) => {
    setPinnedKey(key);
    setLayout("spotlight");
  };
  const unpin = () => {
    if (!pinnedKey) return;
    setPinnedKey(null);
    setLayout("auto");
  };
  // The toggle. Switching to the grid drops the pin with it: a pinned tile in
  // a grid of equals is a promise the layout cannot keep, and leaving it set
  // would have it reappear the next time the spotlight came up.
  const toggleLayout = () => {
    if (gridMode) {
      setLayout("spotlight");
      return;
    }
    setPinnedKey(null);
    setLayout("grid");
  };

  // A fresh room is a fresh stage: neither the pin nor the layout choice
  // follows you into the next call.
  useEffect(() => {
    setPinnedKey(null);
    setLayout("auto");
  }, [hereInCall, channel.id]);

  // ---- 45-5 / 47-4: pop tiles out -------------------------------------
  //
  // A window per tile, as many as you like: three faces and a screen share
  // side by side is the case this is for. Where no window can be had (a
  // blocked pop-up) the in-app expanded view stands in, one tile at a time.
  // Every view shows the SAME stream -- nothing is cloned, so a pop-out costs
  // no extra decode or bandwidth.
  const expanded = expandedKey
    ? (stageTiles.find((t) => t.key === expandedKey) ?? null)
    : null;

  useEffect(() => subscribePopouts(() => setPopped(popoutKeys())), []);

  const popLabel = (tile: StageTile) =>
    handleFor(tile.userID) + (tile.isScreen ? " — screen" : "");

  // Video only: a pop-out of an audio-only peer would be a black rectangle,
  // and their audio is already playing through the dock either way.
  const popOut = (tile: StageTile) => {
    if (!tile.stream || !tile.hasLiveVideo) return;
    if (popped.includes(tile.key)) {
      closeTilePopout(tile.key);
      return;
    }
    void openTilePopout(tile.key, tile.stream, popLabel(tile)).then((opened) => {
      if (!opened) setExpandedKey(tile.key);
    });
  };

  // Keep the open windows honest: one whose tile stopped showing video closes,
  // one whose stream was swapped mid-call follows the new stream.
  useEffect(() => {
    if (popped.length === 0) return;
    syncTilePopouts(
      stageTiles
        .filter((t) => t.stream && t.hasLiveVideo)
        .map((t) => ({ key: t.key, stream: t.stream as MediaStream, label: popLabel(t) })),
    );
    // popLabel is derived from the roster this render; re-running on tile
    // changes is enough to keep titles current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageTiles, popped]);

  // The expanded view follows the call: it closes when what it was showing
  // stops (peer left, share ended, camera off) and when the call itself does.
  useEffect(() => {
    if (expandedKey && !expanded?.hasLiveVideo) setExpandedKey(null);
  }, [expandedKey, expanded]);
  useEffect(() => {
    if (!hereInCall) setExpandedKey(null);
  }, [hereInCall]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedKey(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

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
            onClick={() => join()}
            data-testid="voice-join"
          >
            {hereJoining ? "joining…" : "join voice"}
          </button>
          {!keyReady && <span class="chalk-voice-note">waiting for channel key…</span>}
          {roster.length === 0 && keyReady && !elsewhere && (
            <span class="chalk-voice-note">nobody in here yet — be the first</span>
          )}
        </div>
      ) : (
        <>
          <div class="chalk-voice-stage" data-testid="voice-stage">
            {gridMode ? (
              <div
                class={
                  "chalk-voice-grid" +
                  (isCrowded(stageTiles.length) ? " chalk-voice-grid--crowded" : "")
                }
                style={`--voice-grid-rows: ${grid.rows}`}
                data-testid="voice-grid"
              >
                {stageTiles.map((t) => (
                  <StagePeer
                    key={t.key}
                    tile={t}
                    grid
                    label={handleFor(t.userID)}
                    rttMs={rttByKey[t.key]}
                    onClick={() => pinFromGrid(t.key)}
                    onPopOut={t.hasLiveVideo ? () => popOut(t) : undefined}
                    poppedOut={popped.includes(t.key)}
                    snap={snap}
                    channel={channel}
                    selfUserID={selfUserID}
                  />
                ))}
                {Array.from({ length: grid.dummies }, (_, i) => (
                  <div
                    key={`dummy-${i}`}
                    class="chalk-voice-peer chalk-voice-peer--grid chalk-voice-peer--dummy"
                    data-testid="voice-tile-dummy"
                    aria-hidden="true"
                  />
                ))}
              </div>
            ) : (
              <>
                {focused && (
                  <div class="chalk-voice-big">
                    <StagePeer
                      tile={focused}
                      label={handleFor(focused.userID)}
                      rttMs={rttByKey[focused.key]}
                      big
                      onClick={unpin}
                      onPopOut={focused.hasLiveVideo ? () => popOut(focused) : undefined}
                      poppedOut={popped.includes(focused.key)}
                      snap={snap}
                      channel={channel}
                      selfUserID={selfUserID}
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
                        rttMs={rttByKey[t.key]}
                        onClick={() => setPinnedKey(t.key)}
                        onPopOut={t.hasLiveVideo ? () => popOut(t) : undefined}
                        poppedOut={popped.includes(t.key)}
                        snap={snap}
                        channel={channel}
                        selfUserID={selfUserID}
                      />
                    ))}
                  </div>
                )}
              </>
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
            {snap.sharing && (
              <span class="chalk-voice-modes" data-testid="voice-share-modes">
                {(
                  [
                    ["motion", "game", "Smooth motion — holds FPS, drops resolution under pressure (game mode)"],
                    ["detail", "screen", "Sharp detail — holds resolution, drops FPS under pressure"],
                    ["text", "text", "Sharp text — holds resolution + AV1 screen-content tools when available (docs/code)"],
                  ] as [ScreenShareMode, string, string][]
                ).map(([mode, label, hint]) => (
                  <button
                    key={mode}
                    class={
                      "chalk-btn chalk-voice-ctl" +
                      (snap.shareMode === mode ? " chalk-voice-ctl--on" : "")
                    }
                    onClick={() => voiceSession.setShareMode(mode)}
                    title={hint}
                    data-testid={"voice-mode-" + mode}
                  >
                    {label}
                  </button>
                ))}
              </span>
            )}
            {/* 96-2: the layout, switchable rather than inferred. The 63-1
                rule is a good default and a bad law -- three people with one
                of them screen-sharing a terminal, or two people who want
                equal tiles, both want the other layout. Lit when the grid is
                what you are looking at, whether by rule or by choice. */}
            {stageTiles.length > 1 && (
              <button
                class={"chalk-btn chalk-voice-ctl" + (gridMode ? " chalk-voice-ctl--on" : "")}
                onClick={toggleLayout}
                data-testid="voice-layout-toggle"
                aria-pressed={gridMode ? "true" : "false"}
                title={
                  gridMode
                    ? "switch to the spotlight — one big tile, the rest in a strip"
                    : "switch to tiles — everyone the same size"
                }
              >
                tiles
              </button>
            )}
            <button
              class={"chalk-btn chalk-voice-ctl" + (debugOpen ? " chalk-voice-ctl--on" : "")}
              onClick={() => setDebugOpen((v) => !v)}
              data-testid="voice-debug-toggle"
              title="signaling + transport diagnostics"
            >
              debug
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
              <div class="chalk-voice-drawer-knobs" data-testid="voice-net-knobs">
                <span class="chalk-voice-drawer-peer">transport</span>
                <button
                  class={
                    "chalk-btn chalk-voice-ctl" +
                    (net.transport === "relay" ? " chalk-voice-ctl--on" : "")
                  }
                  onClick={() =>
                    setNet({ transport: net.transport === "relay" ? "auto" : "relay" })
                  }
                  data-testid="voice-knob-relay"
                  title="Send everything through the TURN server instead of peer-to-peer. Hides your address from the others and gets through restrictive networks; costs the server bandwidth."
                >
                  relay only
                </button>
                <button
                  class={
                    "chalk-btn chalk-voice-ctl" + (net.ipv4Only ? " chalk-voice-ctl--on" : "")
                  }
                  onClick={() => setNet({ ipv4Only: !net.ipv4Only })}
                  data-testid="voice-knob-ipv4"
                  title="Ignore IPv6 paths on both sides. For a machine whose IPv6 interface (VM or VPN bridge) looks up but never connects."
                >
                  ipv4 only
                </button>
                <button
                  class={"chalk-btn chalk-voice-ctl" + (net.noHost ? " chalk-voice-ctl--on" : "")}
                  onClick={() => setNet({ noHost: !net.noHost })}
                  data-testid="voice-knob-nohost"
                  title="Ignore local-network paths, so a call never takes the LAN shortcut and your local addresses are not advertised."
                >
                  no lan
                </button>
                <span class="chalk-voice-note" data-testid="voice-knob-effective">
                  {diag ? `ice policy: ${diag.net.effectivePolicy}` : "ice policy: —"}
                  {diag?.forceRelay && " (server-forced)"}
                </span>
                <button
                  class="chalk-btn chalk-voice-ctl"
                  onClick={() => void rejoin()}
                  data-testid="voice-knob-rejoin"
                  title="Leave and come straight back, so the transport setting applies to peers you are already connected to"
                >
                  rejoin
                </button>
              </div>
              <div class="chalk-voice-drawer-stats">
                {diag?.adaptive && (
                  <div class="chalk-voice-drawer-pair" data-testid="voice-adaptive-line">
                    <span class="chalk-voice-drawer-peer">adaptive</span>{" "}
                    uplink≈{diag.adaptive.uplinkKbps}kbps
                    {diag.adaptive.probeKbps !== null && ` (probe ${diag.adaptive.probeKbps})`}
                    {" · "}video {diag.adaptive.videoBudgetKbps}kbps
                    {diag.adaptive.screenTier !== null && (
                      <>
                        {" · "}screen {diag.adaptive.screenTier} @
                        {diag.adaptive.perScreenKbps}kbps
                      </>
                    )}
                    {diag.adaptive.perCameraKbps > 0 &&
                      ` · cam ${diag.adaptive.perCameraKbps}kbps`}
                  </div>
                )}
                {/* 52-3: what the blur is costing, and whether it has had to
                    thin out its segmentation to fit. The first place to look
                    when someone reports choppy video with blur on. */}
                {diag?.blur && (
                  <div class="chalk-voice-drawer-pair" data-testid="voice-blur-line">
                    <span class="chalk-voice-drawer-peer">blur</span>{" "}
                    {diag.blur.costMs}ms/frame
                    {" · "}
                    {diag.blur.every === 1
                      ? "every frame"
                      : `every ${diag.blur.every} frames`}
                    {diag.blur.gaveUp && " · gave up (too slow)"}
                  </div>
                )}
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
                the path filters apply at once; the ice policy applies to peers that
                connect after it — rejoin to change it for a room you are already in.
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

      {expanded && (
        <ExpandedTile
          tile={expanded}
          label={handleFor(expanded.userID) + (expanded.isScreen ? " — screen" : "")}
          onClose={() => setExpandedKey(null)}
        />
      )}

      {/* 45-4: the rules of the room's text, stated where the text is. It sits
          below the call and directly above the feed it describes, and shows in
          the lobby too -- someone typing here before anyone joins is exactly
          the person who needs to know it won't be kept. */}
      <div class="chalk-voice-scratch" data-testid="voice-scratch-note">
        <span class="chalk-voice-scratch-tag">scratchpad</span>
        <span>
          text here is for the call: only what fits stays on screen, older lines
          scroll away for good, and everything is deleted for everyone once the
          last person leaves. keep it short — a line, a link, a GIF.
        </span>
      </div>
    </div>
  );

  // StagePeer stays inside the component body so it can use handleFor
  // without prop-drilling. NO AudioSink here (VoiceDock owns audio).
}

interface StageTile {
  key: string;
  userID: string;
  deviceID: string;
  isSelf: boolean;
  stream: MediaStream | null;
  hasLiveVideo: boolean;
  /** 96-3: this stream carries audio we play back (screen tiles only -- a
   * camera tile's audio is the person's voice, always assumed present). */
  hasAudio?: boolean;
  connState: string | null;
  part?: VoiceParticipant;
  /** 30-7a: this tile is a screen share (own tile, never mirrored, no
   * per-peer audio controls -- those belong to the person's camera tile). */
  isScreen?: boolean;
}

function StagePeer({
  tile,
  label,
  big,
  grid,
  rttMs,
  onClick,
  onPopOut,
  poppedOut,
  snap,
  channel,
  selfUserID,
}: {
  tile: StageTile;
  label: string;
  big?: boolean;
  /** 66-5: last measured round trip to this peer, when the overlay is on. */
  rttMs?: number;
  /** 63-1: equal-size grid tile (group calls); clicking pins to spotlight. */
  grid?: boolean;
  onClick?: () => void;
  /** 45-5: show this stream in a window of its own (expanded in-app when no
   * window can be had). Absent on tiles with no stream to show. */
  onPopOut?: () => void;
  /** This tile already has a window open; the button puts it back. */
  poppedOut?: boolean;
  snap: VoiceSessionSnap;
  channel: ChannelSummary;
  selfUserID: string;
}) {
  // 96-3: a screen tile now has prefs of its own (the share's program audio),
  // so it reads the same row -- just the other pair of fields.
  const pref = tile.isSelf ? undefined : snap.peerAudio[tile.userID];
  const screenMuted = !!pref?.screenMuted;
  const screenVolume = pref?.screenVolume ?? 1;
  const shownLabel = tile.isScreen ? `${label} — screen` : label;
  // 63-2: green dot = sound arriving from this tile right now. Camera tiles
  // only (a share's audio, when any, belongs to the person's camera tile);
  // self runs off the transmit gate -- the honest "what others hear".
  const audible = !tile.isScreen && (tile.isSelf ? snap.micOpen && !snap.muted : !!snap.speaking[tile.key]);
  return (
    <div
      class={
        "chalk-voice-peer" +
        (big
          ? " chalk-voice-peer--big"
          : grid
            ? " chalk-voice-peer--grid"
            : " chalk-voice-peer--strip") +
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
      title={big ? shownLabel : `${shownLabel} — click to focus`}
    >
      {tile.stream ? (
        <>
          <VideoSurface stream={tile.stream} mirrored={tile.isSelf && !tile.isScreen} />
          {!tile.hasLiveVideo && (
            <div class="chalk-voice-avatar chalk-voice-avatar--overlay" aria-hidden="true">
              {(label === "you" ? handleForSelfInitial(channel, selfUserID) : label).slice(0, 1).toUpperCase()}
            </div>
          )}
        </>
      ) : (
        <div class="chalk-voice-avatar" aria-hidden="true">
          {(label === "you" ? handleForSelfInitial(channel, selfUserID) : label).slice(0, 1).toUpperCase()}
        </div>
      )}
      {audible && (
        <span
          class="chalk-voice-speak-dot"
          data-testid="voice-speaking"
          title={tile.isSelf ? "your mic is live" : "receiving audio"}
        />
      )}
      {/* 66-5: the round trip to this person, opposite the speaking dot. Self
          has no round trip to itself, and a screen tile shares its owner's
          connection -- the number belongs on the camera tile, once. */}
      {rttMs !== undefined && !tile.isSelf && (
        <span
          class={"chalk-voice-rtt" + rttSeverityClass(rttMs)}
          data-testid="voice-tile-rtt"
          title={`round trip to ${label}: ${rttMs} ms${
            rttMs >= RTT_BAD_MS
              ? " — high enough to talk over each other"
              : rttMs >= RTT_WARN_MS
                ? " — noticeable"
                : ""
          }`}
        >
          {rttMs} ms
        </span>
      )}
      <div class="chalk-voice-peer-label">
        <span class="chalk-voice-peer-name">{shownLabel}</span>
        {onPopOut && (
          <button
            class={"chalk-voice-popout" + (poppedOut ? " chalk-voice-popout--on" : "")}
            type="button"
            onClick={(e) => {
              e.stopPropagation(); // must not unpin the tile it pops out
              onPopOut();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title={
              poppedOut
                ? `close the ${shownLabel} window`
                : `watch ${shownLabel} in a window of its own`
            }
            data-testid="voice-tile-popout"
            aria-pressed={poppedOut ? "true" : "false"}
          >
            {/* The strip tile is 148px wide -- the glyph alone there, the
                word on the big and grid tiles where there is room for it. */}
            {big || grid ? (poppedOut ? "⧉ close" : "⧉ popout") : "⧉"}
          </button>
        )}
        {tile.part?.muted && <span class="chalk-voice-peer-flag" title="muted">m</span>}
        {tile.part?.videoOn && <span class="chalk-voice-peer-flag" title="camera on">c</span>}
        {tile.part?.screenOn && (
          <span class="chalk-voice-peer-flag" title="sharing screen">s</span>
        )}
        {!tile.isSelf && (tile.isScreen ? screenMuted : pref?.muted) && (
          <span
            class="chalk-voice-peer-flag chalk-voice-peer-flag--local"
            title={
              tile.isScreen
                ? "their share's sound is muted by you (local — they don't know)"
                : "muted by you (local — they don't know)"
            }
          >
            M
          </span>
        )}
        {!tile.isSelf && tile.connState && tile.connState !== "connected" && (
          <span class="chalk-voice-peer-conn">{tile.connState}…</span>
        )}
        {/* A1/A4 local audio controls (remote peers only). The volume
            slider needs width, so it lives on the BIG tile -- pin a peer
            to adjust them; the strip carries just the mute toggle.
            stopPropagation: these must not re-pin/unpin the tile. */}
        {!tile.isSelf && tile.isScreen && (
          <span
            class="chalk-voice-peer-audio"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <button
              class={
                "chalk-voice-localmute" +
                (snap.screenHidden[tile.userID + ":" + tile.deviceID]
                  ? " chalk-voice-localmute--on"
                  : "")
              }
              type="button"
              onClick={() =>
                voiceSession.toggleScreenHidden(tile.userID + ":" + tile.deviceID)
              }
              title={
                snap.screenHidden[tile.userID + ":" + tile.deviceID]
                  ? `show ${label}'s screen again`
                  : `hide ${label}'s screen for me — they keep sharing to everyone else`
              }
              data-testid="voice-screen-hide"
            >
              {/* 66-4: the words got legible, so the 148px strip tile can no
                  longer carry "hide for me" beside a name. Same split the
                  popout button makes: the phrase where there is room, the
                  verb alone where there isn't -- the title says the rest. */}
              {snap.screenHidden[tile.userID + ":" + tile.deviceID]
                ? big || grid
                  ? "show for me"
                  : "show"
                : big || grid
                  ? "hide for me"
                  : "hide"}
            </button>
            {/* 96-3: the share's own sound. Turning a game down to hear the
                person over it used to be impossible -- one slider drove both
                -- and that is the thing everyone tries first. Same placement
                rule as the camera tile: the slider needs width, so it rides
                the big tile only. */}
            {tile.hasAudio && (
              <>
                {big && !screenMuted && (
                  <input
                    class="chalk-voice-volume"
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={Math.round(screenVolume * 100)}
                    onInput={(e) =>
                      voiceSession.setPeerScreenVolume(
                        tile.userID,
                        Number((e.target as HTMLInputElement).value) / 100,
                      )
                    }
                    title={`${label}'s share volume: ${Math.round(
                      screenVolume * 100,
                    )}% (only for you — their voice is separate)`}
                    aria-label={`${label} screen share volume`}
                    data-testid="voice-screen-volume"
                  />
                )}
                <button
                  class={
                    "chalk-voice-localmute" + (screenMuted ? " chalk-voice-localmute--on" : "")
                  }
                  type="button"
                  onClick={() => voiceSession.setPeerScreenLocalMute(tile.userID, !screenMuted)}
                  title={
                    screenMuted
                      ? `unmute ${label}'s share (their voice was never muted with it)`
                      : `mute the sound from ${label}'s share for me — you still hear them talk`
                  }
                  data-testid="voice-screen-mute"
                >
                  {screenMuted
                    ? big || grid
                      ? "unmute sound"
                      : "unmute"
                    : big || grid
                      ? "mute sound"
                      : "mute"}
                </button>
              </>
            )}
          </span>
        )}
        {!tile.isSelf && !tile.isScreen && (
          <span
            class="chalk-voice-peer-audio"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {big && !pref?.muted && (
              <input
                class="chalk-voice-volume"
                type="range"
                min="0"
                max="100"
                step="5"
                value={Math.round((pref?.volume ?? 1) * 100)}
                onInput={(e) =>
                  voiceSession.setPeerVolume(
                    tile.userID,
                    Number((e.target as HTMLInputElement).value) / 100,
                  )
                }
                title={`${label} volume: ${Math.round((pref?.volume ?? 1) * 100)}% (only for you)`}
                aria-label={`${label} playback volume`}
                data-testid="voice-peer-volume"
              />
            )}
            <button
              class={
                "chalk-voice-localmute" + (pref?.muted ? " chalk-voice-localmute--on" : "")
              }
              type="button"
              onClick={() => voiceSession.setPeerLocalMute(tile.userID, !pref?.muted)}
              title={
                pref?.muted
                  ? `unmute ${label} (was muted only for you)`
                  : `mute ${label} for me — they keep talking to everyone else`
              }
              data-testid="voice-peer-localmute"
            >
              {pref?.muted
                ? big || grid
                  ? "unmute for me"
                  : "unmute"
                : big || grid
                  ? "mute for me"
                  : "mute"}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}


/**
 * ExpandedTile (45-5): one stream filling the app, for the engines that have
 * no document Picture-in-Picture (Firefox, Safari) and for a browser that
 * refused to open one. Backdrop click and Escape close it; the fullscreen
 * button hands the same element to the Fullscreen API, which all three
 * engines do have.
 *
 * Muted, like every other video surface here: VoiceDock owns audio output.
 */
function ExpandedTile({
  tile,
  label,
  onClose,
}: {
  tile: StageTile;
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const toggleFullscreen = () => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    // Safari still wants the prefixed call.
    const anyEl = el as HTMLDivElement & { webkitRequestFullscreen?: () => void };
    if (el.requestFullscreen) void el.requestFullscreen();
    else anyEl.webkitRequestFullscreen?.();
  };
  return (
    <div
      ref={ref}
      class="chalk-voice-expanded"
      data-testid="voice-expanded"
      role="dialog"
      aria-label={label}
      onClick={onClose}
    >
      <div class="chalk-voice-expanded-stage" onClick={(e) => e.stopPropagation()}>
        {tile.stream ? (
          <VideoSurface stream={tile.stream} mirrored={tile.isSelf && !tile.isScreen} />
        ) : (
          <div class="chalk-voice-avatar" aria-hidden="true">
            {label.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div class="chalk-voice-expanded-bar">
          <span class="chalk-voice-expanded-name">{label}</span>
          <span class="chalk-voice-bar-spacer" />
          <button
            class="chalk-btn chalk-voice-ctl"
            onClick={toggleFullscreen}
            data-testid="voice-expanded-fullscreen"
          >
            fullscreen
          </button>
          <button
            class="chalk-btn chalk-voice-ctl"
            onClick={onClose}
            data-testid="voice-expanded-close"
            title="close (esc)"
          >
            close
          </button>
        </div>
      </div>
    </div>
  );
}

function handleForSelfInitial(channel: ChannelSummary, selfUserID: string): string {
  const m = (channel.members ?? []).find((x) => x.userID === selfUserID);
  return m?.handle || "y";
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

