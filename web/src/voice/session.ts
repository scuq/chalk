// VoiceSession (Phase 30, slice 30-5c): the app-level owner of THE call.
//
// Discord's defining voice behavior is that a call is not a page -- you
// connect to a room and keep browsing text channels while connected, with a
// small dock showing the connection. That is impossible while the call is
// owned by the per-channel VoiceCallPanel (unmount == leave, the 30-4/30-5
// simplification). This module lifts ownership to a singleton that outlives
// any component:
//
//   * exactly ONE live VoiceCall at a time (join elsewhere = move rooms)
//   * components are VIEWS: they subscribe(), render snap(), and call the
//     imperative methods -- the panel shows the stage when you're looking at
//     the room, the dock shows the connection everywhere else
//   * remote AUDIO is the dock's job (rendered once, app-level), so sound
//     keeps flowing while you read a text channel
//   * lifecycle edges that used to ride on unmount now ride on explicit
//     app-level events: leaveIfChannelGone (removal/kick), handleWsDown
//     (design §9 v1: WS loss = drop from room), reset (logout)
//
// The singleton subscribes to voiceBus once at module init; frames reach the
// live call no matter which components are mounted.

import type { Frame } from "../proto";
import type { WSClient } from "../ws-client";
import type { ChannelCrypto } from "../crypto/channel-crypto";
import { loadIdentity } from "../crypto/idb";
import { voiceBus } from "./bus";
import { VoiceCall, type VoiceDiagnostics, type ScreenShareMode } from "./call";
export type { ScreenShareMode } from "./call";

// ---- per-peer local audio prefs (Addendum A: A1 + the element-volume
// ---- subset of A4) ---------------------------------------------------------
//
// Receive-side only: local mute and 0..1 volume applied to OUR playback of a
// peer. Never touches the wire -- the peer's uplink and everyone else's ears
// are unchanged, and nothing is broadcast (unlike self-mute, which rides
// voice_state for the roster). Persisted per CHANNEL per USER in
// localStorage (design A1: the driving case is "my partner sits beside me
// in this room" -- a room-scoped preference that must survive rejoins).
// Volume above 100% (boost) needs the Web Audio gain graph -- that is the
// vv-5 audio-engine slice, not this one.

export interface PeerAudioPref {
  /** Local mute (A1). Independent of volume so unmute restores the level. */
  muted: boolean;
  /** Playback volume 0..1 (A4 subset; HTMLMediaElement.volume ceiling). */
  volume: number;
}

const PEER_AUDIO_LS_KEY = "chalk-voice-peer-audio";

// ---- refresh rejoin (30-5h) -------------------------------------------------
//
// A page reload tears down every RTCPeerConnection, the getUserMedia streams
// and the WebSocket -- WebRTC state cannot survive a reload, so a true
// "stay connected" is impossible. Instead we remember which room we were in
// (sessionStorage: survives reload, dies with the tab) and the app offers a
// ONE-CLICK rejoin on next mount. One click is required anyway -- browsers
// gate mic/camera and audio playback behind a user gesture, and it doubles as
// the loop guard (no silent auto-rejoin that could crash-loop).

const REJOIN_SS_KEY = "chalk-voice-rejoin";

export interface RejoinHint {
  channelID: string;
  channelName: string;
}

function saveRejoinHint(h: RejoinHint): void {
  try {
    sessionStorage.setItem(REJOIN_SS_KEY, JSON.stringify(h));
  } catch {
    /* private mode / quota: rejoin simply won't be offered */
  }
}

function clearRejoinHint(): void {
  try {
    sessionStorage.removeItem(REJOIN_SS_KEY);
  } catch {
    /* ignore */
  }
}

/** Read (and keep) the rejoin hint left by a prior session, if any. Called
 * once on app mount. */
export function readRejoinHint(): RejoinHint | null {
  try {
    const raw = sessionStorage.getItem(REJOIN_SS_KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as RejoinHint;
    return h && typeof h.channelID === "string" ? h : null;
  } catch {
    return null;
  }
}

type PeerAudioStore = Record<string, Record<string, PeerAudioPref>>; // channel -> user -> pref

function loadPeerAudioStore(): PeerAudioStore {
  try {
    const raw = localStorage.getItem(PEER_AUDIO_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PeerAudioStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePeerAudioStore(s: PeerAudioStore): void {
  try {
    localStorage.setItem(PEER_AUDIO_LS_KEY, JSON.stringify(s));
  } catch {
    /* quota/private-mode: prefs simply won't persist */
  }
}

function normalizePref(p: Partial<PeerAudioPref> | undefined): PeerAudioPref {
  const vol = typeof p?.volume === "number" ? p.volume : 1;
  return {
    muted: !!p?.muted,
    volume: Math.min(1, Math.max(0, vol)),
  };
}

export interface SessionRemoteTile {
  key: string;
  userID: string;
  deviceID: string;
  stream: MediaStream;
  connState: string;
  /** 30-7a: the peer's screen-share stream while it is sharing, else null.
   * Rendered as its own stage tile, distinct from the camera tile. */
  screenStream: MediaStream | null;
}

export type SessionPhase = "idle" | "joining" | "in-call";

/** Immutable render snapshot. A new object per change (referential
 * inequality is the re-render signal for subscribers). */
export interface VoiceSessionSnap {
  phase: SessionPhase;
  /** The room the session is in (or joining). null when idle. */
  channelID: string | null;
  channelName: string;
  tiles: Record<string, SessionRemoteTile>;
  localStream: MediaStream | null;
  muted: boolean;
  camOn: boolean;
  /** 30-7a: our own screen share -- null when not sharing. `sharing` is its
   * derived boolean, kept explicit for cheap render checks. */
  localScreenStream: MediaStream | null;
  sharing: boolean;
  /** 30-7b: the B0 priority mode of our share (sticky within the call). */
  shareMode: ScreenShareMode;
  /** 30-7b (B5/A1): remote screen shares hidden LOCALLY, by peer key.
   * View-side only -- the sharer and everyone else are untouched, nothing
   * is signaled. Transient: reset on leave, sticky across re-shares. */
  screenHidden: Record<string, boolean>;
  joinedWithVideo: boolean;
  relayOnly: boolean;
  joinedAt: number | null;
  /** Last user-visible problem; cleared on the next join attempt. */
  error: string | null;
  /** Per-peer LOCAL audio prefs for the current room, keyed by userID
   * (A1 local mute + A4-subset volume). Loaded from localStorage on join. */
  peerAudio: Record<string, PeerAudioPref>;
  /** 30-5h: a room we were connected to before a page reload. Consumed once
   * by App to auto-rejoin (30-5i). */
  rejoinHint: RejoinHint | null;
  /** 30-5i: remote audio playback is suspended by the browser's autoplay
   * policy (common right after an auto-rejoin with no user gesture). The
   * dock shows a "click to enable audio" nudge; any click resumes it. */
  audioBlocked: boolean;
}

export interface JoinArgs {
  channelID: string;
  channelName: string;
  selfUserID: string;
  selfDeviceID: string;
  /** Live refs from App -- read .current at call time (reconnect-safe). */
  client: { current: WSClient | null };
  cc: { current: ChannelCrypto | null };
}

class VoiceSessionImpl {
  private call: VoiceCall | null = null;
  private listeners = new Set<() => void>();
  private s: VoiceSessionSnap = {
    phase: "idle",
    channelID: null,
    channelName: "",
    tiles: {},
    localStream: null,
    muted: false,
    camOn: false,
    localScreenStream: null,
    sharing: false,
    shareMode: "detail",
    screenHidden: {},
    joinedWithVideo: false,
    relayOnly: false,
    joinedAt: null,
    error: null,
    peerAudio: {},
    rejoinHint: null,
    audioBlocked: false,
  };

  constructor() {
    // One bus subscription for the app's lifetime; the manager filters by
    // channel + self, so stray frames are inert.
    voiceBus.subscribe((f: Frame) => this.call?.handleFrame(f));
    // 30-5h: a hint left by a prior page load = offer a one-click rejoin.
    this.s.rejoinHint = readRejoinHint();
  }

  // ---- store surface -------------------------------------------------------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snap(): VoiceSessionSnap {
    return this.s;
  }

  private set(patch: Partial<VoiceSessionSnap>): void {
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error("voice session listener threw:", err);
      }
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * join connects to a room. Joining the room we're already in is a no-op;
   * joining a DIFFERENT room first leaves the current one (Discord's
   * move-between-rooms behavior -- one call at a time, by design and by
   * the server's one-device-per-user rule).
   */
  async join(a: JoinArgs): Promise<void> {
    if (this.s.phase === "joining") return;
    if (this.s.phase === "in-call") {
      if (this.s.channelID === a.channelID) return; // already here
      await this.leave(); // move rooms
    }
    const ws = a.client.current;
    const crypto_ = a.cc.current;
    if (!ws || !ws.isOpen() || !crypto_) {
      this.set({ error: "not connected" });
      return;
    }
    this.set({
      phase: "joining",
      channelID: a.channelID,
      channelName: a.channelName,
      error: null,
      // A1 persistence: restore this room's local mutes/volumes.
      peerAudio: Object.fromEntries(
        Object.entries(loadPeerAudioStore()[a.channelID] ?? {}).map(([u, p]) => [
          u,
          normalizePref(p),
        ]),
      ),
    });
    try {
      const ident = await loadIdentity(a.selfUserID);
      if (!ident) throw new Error("no local identity — complete identity setup first");
      const call = new VoiceCall({
        channelID: a.channelID,
        selfUserID: a.selfUserID,
        selfDeviceID: a.selfDeviceID,
        transport: {
          request: (t, p) => a.client.current!.request(t, p),
          send: (t, p, r) => a.client.current!.send(t, p, r),
          isOpen: () => a.client.current?.isOpen() ?? false,
        },
        crypto: crypto_,
        ed25519Private: ident.ed25519Private,
        callbacks: {
          onPeerStream: (key, userID, deviceID, stream) =>
            this.set({
              tiles: {
                ...this.s.tiles,
                [key]: {
                  key,
                  userID,
                  deviceID,
                  stream,
                  connState: this.s.tiles[key]?.connState ?? "connecting",
                  // Preserve a screen stream that arrived first (30-7a).
                  screenStream: this.s.tiles[key]?.screenStream ?? null,
                },
              },
            }),
          onPeerGone: (key) => {
            const { [key]: _gone, ...rest } = this.s.tiles;
            this.set({ tiles: rest });
          },
          onPeerState: (key, state) => {
            const t = this.s.tiles[key];
            if (t) this.set({ tiles: { ...this.s.tiles, [key]: { ...t, connState: state } } });
          },
          onLocalStream: (stream) => this.set({ localStream: stream }),
          onLocalScreenStream: (stream) =>
            this.set({ localScreenStream: stream, sharing: stream !== null }),
          onPeerScreenStream: (key, userID, deviceID, stream) => {
            // 30-7b: a peer we hid earlier re-shared -- keep it hidden
            // (sticky per call) by disabling the fresh video tracks too.
            if (this.s.screenHidden[key]) {
              for (const t of stream.getVideoTracks()) t.enabled = false;
            }
            // Upsert: the camera tile normally exists already (the screen
            // renegotiation strictly follows the first negotiation), but a
            // race-created tile is tolerated -- onPeerStream will replace
            // `stream` and keep `screenStream`.
            const prev = this.s.tiles[key];
            this.set({
              tiles: {
                ...this.s.tiles,
                [key]: prev
                  ? { ...prev, screenStream: stream }
                  : {
                      key,
                      userID,
                      deviceID,
                      stream,
                      connState: "connecting",
                      screenStream: stream,
                    },
              },
            });
          },
          onPeerScreenGone: (key) => {
            const t = this.s.tiles[key];
            if (t && t.screenStream !== null) {
              this.set({ tiles: { ...this.s.tiles, [key]: { ...t, screenStream: null } } });
            }
          },
          onError: (msg) => this.set({ error: msg }),
        },
      });
      this.call = call;
      await call.join();
      this.set({
        phase: "in-call",
        relayOnly: call.relayOnly,
        // joinedWithVideo = a camera track was acquired (30-5h). camOn starts
        // false -- camera is off by default, the panel toggle flips it.
        joinedWithVideo: call.joinedWithVideo,
        camOn: false,
        muted: false,
        joinedAt: Date.now(),
      });
      // 30-5h: remember the room so a page reload can offer a one-click
      // rejoin. Cleared on user-initiated leave, kept across refresh.
      saveRejoinHint({ channelID: a.channelID, channelName: a.channelName });
      if (this.s.rejoinHint) this.set({ rejoinHint: null });
    } catch (err) {
      const raw = String(err instanceof Error ? err.message : err);
      const dead = this.call;
      this.call = null;
      if (dead) void dead.leave();
      this.set({
        phase: "idle",
        channelID: null,
        channelName: "",
        tiles: {},
        localStream: null,
        joinedAt: null,
        error: raw,
      });
    }
  }

  /**
   * leave disconnects and resets to idle. Idempotent.
   *
   * userInitiated (default true) clears the refresh-rejoin hint: an explicit
   * "leave" means don't offer to rejoin. The App's unmount/teardown paths
   * pass false so a page reload keeps the hint and can offer a rejoin.
   */
  async leave(userInitiated = true): Promise<void> {
    if (userInitiated) clearRejoinHint();
    const call = this.call;
    this.call = null;
    this.set({
      phase: "idle",
      channelID: null,
      channelName: "",
      tiles: {},
      localStream: null,
      muted: false,
      camOn: false,
      localScreenStream: null,
      sharing: false,
      shareMode: "detail",
      screenHidden: {},
      joinedWithVideo: false,
      relayOnly: false,
      joinedAt: null,
      peerAudio: {},
      audioBlocked: false,
    });
    if (call) await call.leave();
  }

  // ---- app-level lifecycle edges ------------------------------------------

  /** WS loss while connected (design §9 v1): drop from the room -- the
   * server already vacated our row by conn_id; lingering locally would be
   * a ghost call. The user rejoins with one click once the socket is back. */
  handleWsDown(): void {
    if (this.s.phase === "idle") return;
    // Keep the rejoin hint (leave(false)): a dropped socket -- including the
    // brief not-open window while the app boots after a refresh -- should
    // still offer a one-click rejoin, not silently forget the room.
    void this.leave(false);
    this.set({
      error: "connection lost — you left the voice room; rejoin once reconnected",
    });
  }

  /** 30-6 cascade, client side: our room disappeared from the channel list
   * (we were removed / the channel was deleted). */
  leaveIfChannelGone(liveChannelIDs: ReadonlySet<string>): void {
    const cid = this.s.channelID;
    if (cid !== null && !liveChannelIDs.has(cid)) {
      void this.leave();
      this.set({ error: "you are no longer a member of that voice room" });
    }
  }

  /** Logout: full teardown, error cleared (nothing to tell a logged-out user). */
  reset(): void {
    void this.leave();
    this.set({ error: null });
  }

  // ---- in-call controls ----------------------------------------------------

  toggleMute(): void {
    if (!this.call) return;
    const next = !this.s.muted;
    this.call.setMuted(next);
    this.set({ muted: next });
  }

  /** Returns false when the call has no camera track (joined audio-only). */
  toggleCam(): boolean {
    if (!this.call) return false;
    if (!this.call.joinedWithVideo) return false;
    const next = !this.s.camOn;
    if (this.call.setVideoEnabled(next)) {
      this.set({ camOn: next });
      return true;
    }
    return false;
  }

  /**
   * toggleScreenShare (30-7a): start or stop the screen share. Start opens
   * the browser's display picker (needs the click's user gesture -- call
   * it synchronously from the handler). State flows exclusively through
   * the onLocalScreenStream callback, so the snapshot can never disagree
   * with the call (the browser "Stop sharing" bar also lands there).
   */
  async toggleScreenShare(): Promise<void> {
    const call = this.call;
    if (!call) return;
    if (call.isSharingScreen) {
      await call.stopScreenShare();
    } else {
      await call.startScreenShare();
    }
  }

  /** 30-7b (B0): flip our share's priority mode. Applies live (hint + fps
   * + bitrate/degradation; codec renegotiates only on a ranking change)
   * and sticks for the next share within this call. */
  setShareMode(mode: ScreenShareMode): void {
    this.call?.setScreenShareMode(mode);
    if (this.s.shareMode !== mode) this.set({ shareMode: mode });
  }

  /**
   * toggleScreenHidden (30-7b, B5/A1): locally hide/show one peer's screen
   * share. Disables OUR copy of the receiver's video tracks (skips render;
   * never signaled -- the sharer keeps streaming to everyone else) and
   * flags the tile so the stage renders the placeholder.
   */
  toggleScreenHidden(key: string): void {
    const hidden = !this.s.screenHidden[key];
    const t = this.s.tiles[key];
    if (t?.screenStream) {
      for (const v of t.screenStream.getVideoTracks()) v.enabled = !hidden;
    }
    this.set({ screenHidden: { ...this.s.screenHidden, [key]: hidden } });
  }

  /**
   * enableCamera (30-7b): the audio-only escape hatch -- acquire a camera
   * mid-call and renegotiate it in. Resolves false when acquisition failed
   * (the call surfaces the reason via its error callback).
   */
  async enableCamera(): Promise<boolean> {
    const call = this.call;
    if (!call) return false;
    const ok = await call.enableCameraMidCall();
    if (ok) this.set({ joinedWithVideo: true, camOn: true });
    return ok;
  }

  clearError(): void {
    if (this.s.error !== null) this.set({ error: null });
  }

  /** 30-5h: user declined the post-reload rejoin (or it was consumed). */
  dismissRejoin(): void {
    clearRejoinHint();
    if (this.s.rejoinHint) this.set({ rejoinHint: null });
  }

  /**
   * consumeRejoinHint (30-5i) returns the stored room ONCE and immediately
   * clears both storage and the snapshot flag, so the auto-rejoin can never
   * fire twice or crash-loop: a failed rejoin has already consumed the hint
   * and won't retry. Returns null if there's nothing to rejoin.
   */
  consumeRejoinHint(): RejoinHint | null {
    const h = this.s.rejoinHint ?? readRejoinHint();
    if (!h) return null;
    clearRejoinHint();
    if (this.s.rejoinHint) this.set({ rejoinHint: null });
    return h;
  }

  /** 30-5i: flag/clear the autoplay-blocked state for the dock nudge. */
  notifyAudioBlocked(): void {
    if (!this.s.audioBlocked) this.set({ audioBlocked: true });
  }

  clearAudioBlocked(): void {
    if (this.s.audioBlocked) this.set({ audioBlocked: false });
  }

  // ---- per-peer local audio (A1 + A4 subset) -------------------------------

  peerAudioFor(userID: string): PeerAudioPref {
    return normalizePref(this.s.peerAudio[userID]);
  }

  /** A1: locally silence one participant. Persisted per channel. */
  setPeerLocalMute(userID: string, muted: boolean): void {
    this.updatePeerAudio(userID, (p) => ({ ...p, muted }));
  }

  /** A4 subset: playback volume 0..1 for one participant. Persisted. */
  setPeerVolume(userID: string, volume: number): void {
    this.updatePeerAudio(userID, (p) => ({
      ...p,
      volume: Math.min(1, Math.max(0, volume)),
    }));
  }

  private updatePeerAudio(
    userID: string,
    fn: (p: PeerAudioPref) => PeerAudioPref,
  ): void {
    const cid = this.s.channelID;
    const next = fn(normalizePref(this.s.peerAudio[userID]));
    this.set({ peerAudio: { ...this.s.peerAudio, [userID]: next } });
    if (cid !== null) {
      const store = loadPeerAudioStore();
      const room = { ...(store[cid] ?? {}) };
      if (!next.muted && next.volume === 1) {
        // Defaults need no row -- keep the store tidy.
        delete room[userID];
      } else {
        room[userID] = next;
      }
      store[cid] = room;
      savePeerAudioStore(store);
    }
  }

  /** Passthrough to the live call's 30-4c diagnostics blob (config +
   * per-peer selected-pair stats + the bounded event ring). null when
   * idle -- the ring lives in the call and dies with it, by design. */
  diagnostics(): Promise<VoiceDiagnostics | null> {
    return this.call ? this.call.diagnostics() : Promise.resolve(null);
  }
}

/** The one session. Import and use; never construct another. */
export const voiceSession = new VoiceSessionImpl();
