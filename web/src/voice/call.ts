// VoiceCall (Phase 30, slices 30-4 + 30-7a + 30-7b): the client-side WebRTC
// mesh.
//
// One instance == one live membership in one voice room. It owns:
//   * the local capture stream (getUserMedia; audio always, camera optional)
//   * one RTCPeerConnection per remote (user, device) -- full mesh
//   * the signaling handshake over voice_signal frames, E2E-encrypted under
//     the channel space key (signal-crypto.sealSignal/openSignal)
//   * anti-MITM (Slice F): every offer/answer SDP's DTLS fingerprint is
//     Ed25519-signed by the sender and verified against the sender's
//     PUBLISHED identity before the SDP is applied; a bad signature aborts
//     that peer (possible MITM), never silently degrades
//   * iceTransportPolicy: 'relay' when the server says force_relay
//     (CHALK_VOICE_FORCE_RELAY -- the §7d no-P2P acceptance gate) or when
//     this device asks for it (./net-prefs, the debug drawer knobs)
//   * a MINIMAL per-sender uplink budget (design Addendum D says the basic
//     caps + divider land here in 30-4; the probe/ladder arrive in 30-8)
//   * 30-7a (Addendum B): screen sharing on its OWN transceivers (camera
//     stays up), with PERFECT NEGOTIATION for the mid-call track add/remove
//     -- see the renegotiation note below
//
// Glare-free handshake (design §4): the JOINER offers to exactly the peers in
// its voice_join_ack roster; existing peers only answer. Two corners are
// handled beyond the happy path:
//   * concurrent join: two clients join so close together that NEITHER sees
//     the other in its ack roster (each only gets the joined push). Both
//     would wait forever. Fallback: on a joined push for a peer we have no
//     pc for, arm a short timer; when it fires and the DETERMINISTIC LOWER
//     key (userID:deviceID string compare) still has no pc, IT offers.
//   * offer glare: resolved by PERFECT NEGOTIATION (below); the LOWER key
//     is the impolite peer and stays offerer -- same deterministic outcome
//     the join rule always had, now uniform for every offer.
//
// Renegotiation (30-7a, design B2): the join rule ("joiner offers, existing
// answer") only covers the FIRST negotiation. A screen-share start/stop is a
// mid-call track add/remove initiated by an EXISTING peer, so two peers can
// legitimately offer at once. The standard perfect-negotiation pattern
// resolves every collision per peer pair:
//   * roles are deterministic: LOWER (userID:deviceID) key = IMPOLITE,
//     higher = POLITE (consistent with the historical join-glare rule).
//   * a collision = an offer arrives while we are mid-offer ourselves
//     (makingOffer) or not in "stable". The impolite peer IGNORES the
//     colliding offer (the polite side will answer ours); the polite peer
//     rolls back its own attempt (implicit rollback via
//     setRemoteDescription) and answers theirs.
//   * consequence: an offer on an ESTABLISHED pair is now a legal
//     renegotiation, not a rejoin. True rejoins are still safe: the server's
//     conn cleanup guarantees a participant_left push first, which drops the
//     old pc, so a rejoining peer's offer always lands on a fresh peer.
//
// Screen share (30-7a, design B1): its own capture stream + its own
// transceivers per pc; the camera/mic senders are untouched. Receivers tell
// screen from camera by STREAM ID, announced in an encrypted
// {kind:"screen_add", stream_id} control signal sent BEFORE the offer that
// carries the track (same ordered WS relay + same per-peer op chain, so the
// announce is processed first; a small pending buffer tolerates reordering
// anyway).
//
// 30-7b completes Addendum B:
//   * the 3-way share MODE (B0): "motion" (game) / "detail" (screen) /
//     "text" (docs+code). One W3C lever: contentHint + the pinned
//     degradationPreference decide what the encoder sacrifices under
//     pressure -- resolution (motion holds FPS) or framerate (detail/text
//     hold pixels). Flipping the mode mid-share is live: applyConstraints
//     (fps ceiling) + hint + setParameters, no re-capture.
//   * the codec ladder (B3) via setCodecPreferences, MODE-DEPENDENT:
//     detail/text prefer AV1 (screen-content-coding tools; gated behind a
//     CPU heuristic, VP9 -- which also has screen tools -- otherwise);
//     motion prefers VP9 > H.264 (sustainable 60fps; software AV1 would pin
//     a core) > VP8. A mode flip that changes the ranking renegotiates the
//     codec through the 30-7a perfect-negotiation machinery.
//   * shared app/game AUDIO (B3): getDisplayMedia({audio:true}) where the
//     platform supports it (feature-detected; video-only otherwise). It is
//     PROGRAM audio, not a microphone: contentHint "music", its own cap,
//     and it must never run through a mic processing graph (A3, when that
//     exists).
//   * mid-call camera add: joining audio-only is no longer terminal --
//     enableCameraMidCall() acquires and renegotiates the camera in.
//
// The server-side contract this file leans on (30-2): signals are relayed
// only between live participants, payloads are opaque, joined/left/state
// pushes go to all channel members (including our own other devices and our
// own echo -- both filtered out here).

import {
  TypeVoiceJoin,
  TypeVoiceLeave,
  TypeVoiceState,
  TypeVoiceSignal,
  TypeVoiceParticipantJoined,
  TypeVoiceParticipantLeft,
  type Frame,
  type VoiceJoinAckPayload,
  type VoiceSignalSendPayload,
  type VoiceSignalPushPayload,
  type VoiceParticipantJoinedPayload,
  type VoiceParticipantLeftPayload,
  type ICEServerWire,
} from "../proto";
import { fetchIdentity } from "../crypto/identity-sync";
import {
  DEFAULT_ADAPTIVE,
  FALLBACK_UPLINK_BPS,
  HysteresisLadder,
  divideBudget,
  ladderFor,
  parseAdaptiveWire,
  probeUplink,
  type AdaptiveSettings,
  type BudgetPlan,
  type Tier,
} from "./adaptive";
import {
  sealSignal,
  openSignal,
  extractFingerprints,
  signFingerprints,
  verifyFingerprints,
  type VoiceEnvelopeCrypto,
  type SealedSignal,
  type SdpSignal,
  type IceSignal,
  type FingerprintContext,
} from "./signal-crypto";
import { MicChain } from "./mic-chain";
import { CameraChain } from "./camera-chain";
// Static import, but NOT of MediaPipe: camera-blur is a small module that
// import()s the ~12 MB runtime itself, so nothing heavy reaches this bundle.
import { applyBlurTo, type BlurStats } from "./camera-blur";
import {
  DEFAULT_MIC_PREFS,
  loadMicPrefs,
  micConstraints,
  needsRecapture,
  type MicPrefs,
} from "./mic-prefs";
import {
  candidateTypeOf,
  iceTransportPolicyFor,
  loadNetPrefs,
  shouldDropCandidate,
  type NetPrefs,
} from "./net-prefs";
import { cameraConstraints, loadDevicePrefs, type DevicePrefs } from "./device-prefs";
import { VoiceDiagRing, describePair } from "./diag";
export type { VoiceDiagEvent } from "./diag";
import { SpeakingTracker, SPEAKING_POLL_MS } from "./speaking";
import { listAudioInputs, resolveDeviceId, resolveMicPrefs } from "./device-resolve";

// ---- knobs (30-8: video caps are DYNAMIC -- see ./adaptive) ----------------
//
// The fixed 30-4 video-cap constants are gone: per-copy video ceilings now
// come from the Addendum D planner (measured uplink -> headroom -> audio
// reserve -> mesh divider -> tier ladder with hysteresis). Audio caps stay
// constant-ish: voice comes from the server's audio_kbps knob, program audio
// keeps its fixed music-grade cap.

/** Shared PROGRAM audio cap (Opus music, not voice -- 64k would smear it). */
const SCREEN_AUDIO_MAX_BPS = 128_000;
/** How often the passive fast down-guard reads getStats (D2: safety is
 * continuous; only step-UPs wait for the scheduled replan ticks). */
const ADAPTIVE_GUARD_MS = 3_000;

/** The B0 share modes. Values ARE the W3C contentHint strings. */
export type ScreenShareMode = "motion" | "detail" | "text";

/** Codec family preference per mode (B3), best first. AV1 leads for
 * detail/text ONLY when the CPU heuristic passes (see rankedScreenCodecs). */
const CODEC_ORDER_DETAIL_AV1 = ["video/av1", "video/vp9", "video/h264", "video/vp8"];
const CODEC_ORDER_DETAIL_NO_AV1 = ["video/vp9", "video/h264", "video/vp8", "video/av1"];
const CODEC_ORDER_MOTION = ["video/vp9", "video/h264", "video/vp8", "video/av1"];
/** Concurrent-join fallback: how long the lower key waits for the joiner's
 * offer before concluding neither side saw the other in a roster. */
const JOIN_GLARE_FALLBACK_MS = 2_000;

// ---- public surface ---------------------------------------------------------

/** The WSClient slice VoiceCall needs (request for acks, send for signals). */
export interface VoiceTransport {
  request<P, R = unknown>(type: string, payload?: P): Promise<R>;
  send<P>(type: string, payload?: P, ref?: string): void;
  isOpen(): boolean;
}

export interface VoiceCallCallbacks {
  /** A remote peer's media stream is (re)available -- attach to elements. */
  onPeerStream(key: string, userID: string, deviceID: string, stream: MediaStream): void;
  /** A peer left / was torn down -- drop its tiles. */
  onPeerGone(key: string): void;
  /** Connection-state change for a peer ("connecting" | "connected" | ...). */
  onPeerState(key: string, state: string): void;
  /** Local capture stream ready (or null after leave) -- for self-preview. */
  onLocalStream(stream: MediaStream | null): void;
  /** Local screen-share stream started (or null after stop) -- self-preview
   * tile + the panel's share-button state. */
  onLocalScreenStream(stream: MediaStream | null): void;
  /** A remote peer's SCREEN stream is available -- render as a screen tile
   * (distinct from the camera tile delivered via onPeerStream). */
  onPeerScreenStream(key: string, userID: string, deviceID: string, stream: MediaStream): void;
  /** A remote peer stopped sharing -- drop its screen tile. */
  onPeerScreenGone(key: string): void;
  /** Non-fatal, user-visible problem (peer aborted, signal failed, ...). */
  onError(message: string): void;
  /** 63-3: an earlier onError message no longer applies (the missing mic came
   * back). The receiver clears it only if it is still the one showing. */
  onErrorResolved?(message: string): void;
  /** 41-5: the transmit gate opened or closed (VAD / push-to-talk). */
  onMicGate?(open: boolean): void;
  /** 103-2: turning the camera back on could not reopen the device; the
   * call is now camera-off and the session's toggle should say so. */
  onCameraLost?(): void;
  /** 63-2: the set of peers currently audible changed (sorted peer keys).
   * Fires only on change, a few times a second at most. */
  onSpeaking?(keys: string[]): void;
}

export interface VoiceCallOptions {
  channelID: string;
  selfUserID: string;
  selfDeviceID: string;
  transport: VoiceTransport;
  /** ChannelCrypto (structural): E2E envelope for every signal blob. */
  crypto: VoiceEnvelopeCrypto;
  /** Ed25519 identity private key (phase 22) -- signs DTLS fingerprints. */
  ed25519Private: CryptoKey;
  /** 66-2: whether to open the camera at all for this join. False leaves the
   * device untouched (indicator dark); the camera button then acquires one
   * mid-call through enableCameraMidCall. */
  startWithVideo: boolean;
  /** 97-1: the diagnostics ring, normally the session's page-lifetime one so
   * events survive this call's teardown. Absent (guest room), the call makes
   * a private ring and behaves like the 30-4c original. */
  diag?: VoiceDiagRing;
  callbacks: VoiceCallCallbacks;
}

interface Peer {
  key: string; // "<userID>:<deviceID>"
  userID: string;
  deviceID: string;
  pc: RTCPeerConnection;
  /** Queued remote ICE until the remote description is applied. */
  pendingIce: RTCIceCandidateInit[];
  hasRemoteDesc: boolean;
  /** Serializes signaling ops per peer (offer/answer/ice ordering). */
  chain: Promise<void>;
  /** Perfect negotiation (30-7a): true while our createOffer/setLocal
   * window is open -- an incoming offer during it is a collision. */
  makingOffer: boolean;
  /** Perfect negotiation: we (the impolite side) dropped the peer's last
   * colliding offer; its trailing ICE errors are expected noise. */
  ignoreOffer: boolean;
  /** Remote stream IDs announced as screen shares (screen_add). */
  screenStreamIDs: Set<string>;
  /** First non-screen remote stream id == the camera/mic stream. */
  cameraStreamID: string | null;
  /** Remote streams that arrived before their screen_add announce. */
  pendingStreams: Map<string, MediaStream>;
  /** 97-2: the last ICE trouble state a stats snapshot was taken for, so one
   * episode logs each state once. Reset when the link recovers. */
  troubleSnap: string | null;
}

/** screen_add / screen_remove control body (rides encrypted, like SDP/ICE). */
interface ScreenSignal {
  stream_id: string;
}

function peerKey(userID: string, deviceID: string): string {
  return `${userID}:${deviceID}`;
}

/** 63-3: devicechange events arrive in bursts (one device can register as
 * input and output separately); wait for the dust to settle before acting. */
const DEVICE_SETTLE_MS = 800;

/**
 * describeMediaError (30-6): turn getUserMedia's DOMException zoo into a
 * sentence a person can act on. The raw names (NotAllowedError & co.) mean
 * nothing to most users; the fix is almost always a browser permission
 * toggle or a missing/busy device.
 */
export function describeMediaError(device: "microphone" | "camera", err: unknown): string {
  const name = (err as DOMException)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return `${device} permission denied — allow ${device} access for this site in the browser, then rejoin`;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return `no ${device} found — plug one in (or pick one in the OS sound settings), then rejoin`;
    case "NotReadableError":
    case "TrackStartError":
      return `${device} is busy or unreadable — another app may be using it`;
    case "OverconstrainedError":
      return `${device} does not support the requested settings`;
    case "SecurityError":
      return `${device} access blocked — voice needs a secure (https) origin`;
    default:
      return `${device} access failed: ${String((err as Error)?.message ?? err)}`;
  }
}

// ---- diagnostics (30-4c) ----------------------------------------------------
//
// ICE/TURN failures are the hardest thing a user will ever have to explain in
// a bug report, so the manager keeps a structured, always-on event ring (the
// permanent form of the temporary [voice-dbg] console traces) plus a
// getStats() snapshot collector. The VoiceCallPanel's "debug" drawer renders
// both, and "copy diagnostics" produces a pasteable JSON blob. Cheap: the
// ring is bounded and stats run only while the drawer is open.
//
// 97-1: the ring itself moved to ./diag and is normally OWNED BY THE SESSION
// (VoiceCallOptions.diag), so it survives the call teardown a reconnect is.
// The blob here is therefore config + live stats only; the session composes
// it with the ring's events (VoiceSessionDiagnostics).

/** A per-peer live snapshot extracted from RTCPeerConnection.getStats(). */
export interface VoicePeerDiag {
  key: string;
  connectionState: string;
  iceConnectionState: string;
  iceGatheringState: string;
  signalingState: string;
  /** Selected candidate pair, when one exists. */
  pair?: {
    localType: string;
    localAddr: string;
    remoteType: string;
    remoteAddr: string;
    protocol: string;
    rttMs?: number;
    bytesSent?: number;
    bytesReceived?: number;
    availableOutgoingKbps?: number;
  };
}

/** 30-8: the adaptive planner's last decision, for the debug drawer. */
export interface VoiceAdaptiveDiag {
  uplinkKbps: number;
  probeKbps: number | null;
  statsKbps: number | null;
  videoBudgetKbps: number;
  perCameraKbps: number;
  perScreenKbps: number;
  screenTier: string | null;
}

/** The live call's half of the copyable diagnostics blob: config + stats.
 * 97-1: the event ring is no longer in here -- it outlives the call, so the
 * session carries it (VoiceSessionDiagnostics in ./session). */
export interface VoiceDiagnostics {
  channelID: string;
  self: string;
  forceRelay: boolean;
  /** The device's transport knobs, and the ICE policy they resolve to. */
  net: NetPrefs & { effectivePolicy: RTCIceTransportPolicy };
  iceServerURLs: string[]; // URLs only -- never the short-lived credentials
  peers: VoicePeerDiag[];
  adaptive?: VoiceAdaptiveDiag;
  /** 52-3: present only while our own background blur is running. Absent means
   *  blur is off, or the camera is doing it (which costs us nothing to report
   *  on because it costs us nothing at all). */
  blur?: BlurStats;
}

export class VoiceCall {
  private readonly o: VoiceCallOptions;
  private readonly selfKey: string;
  private readonly peers = new Map<string, Peer>();
  private localStream: MediaStream | null = null;
  /** 41-2: the mic graph. Owns the real capture; localStream carries its output. */
  private micChain: MicChain | null = null;
  /** 44-10: the camera graph. Same deal -- owns the device, publishes a canvas. */
  private cameraChain: CameraChain | null = null;
  /** 52-3: the live blur processor's counters, for the diagnostics drawer.
   *  A getter rather than a snapshot so the drawer reads the current numbers
   *  and not whatever they were when blur was switched on. */
  private blurStats: (() => BlurStats) | null = null;
  /** The prefs the current capture was opened with, to diff incoming changes. */
  private micPrefs: MicPrefs = DEFAULT_MIC_PREFS;
  private iceServers: RTCIceServer[] = [];
  private forceRelay = false;
  /** Per-device transport knobs from the debug drawer (see ./net-prefs). */
  private netPrefs: NetPrefs = loadNetPrefs();
  /** Which camera and which speakers this machine uses (see ./device-prefs). */
  private devicePrefs: DevicePrefs = loadDevicePrefs();
  private joined = false;
  private closed = false;
  private hasVideo = false;
  private muted = false;
  /** 109-1: self-deafen, carried here only so voice_state can broadcast it.
   * The silencing itself is VoiceDock's, on the receive side. */
  private deafened = false;
  private videoEnabled = false;
  /** 30-7a: the local getDisplayMedia stream while sharing, else null. */
  private screenStream: MediaStream | null = null;
  /** 30-7b: the active share mode. Sticky across shares within the call. */
  private screenMode: ScreenShareMode = "detail";
  /** The codec family (mimeType, lowercase) currently applied to the screen
   * transceivers -- a mode flip renegotiates only when this would change. */
  private appliedScreenCodec: string | null = null;
  // 30-8 adaptive quality (Addendum D):
  /** Server policy from voice_join_ack.adaptive (defaults until then). */
  private adaptiveCfg: AdaptiveSettings = DEFAULT_ADAPTIVE;
  /** Pre-stream probe result, bits/s (D1); null = not run / failed. */
  private probeBps: number | null = null;
  /** Last passive getStats uplink estimate, bits/s (D2). */
  private lastStatsBps: number | null = null;
  /** Screen-share rung tracker (D3); ladder follows the share mode. */
  private readonly screenLadder = new HysteresisLadder(ladderFor("detail"));
  /** The tier + plan applyBudget last applied (diagnostics + change diag). */
  private appliedTier: Tier | null = null;
  private lastPlan: BudgetPlan | null = null;
  /** Capture-side fps last constrained onto the screen track. */
  private appliedCaptureFps: number | null = null;
  /** One warning per pause episode (game bottom rung). */
  private pauseWarned = false;
  private guardTimer: number | null = null;
  private recheckTimers: number[] = [];
  // 63-3: mid-call device watch (AirPods appearing, a mic unplugged).
  private deviceWatchOff: (() => void) | null = null;
  private deviceWatchTimer: number | null = null;
  private micSwitching = false;
  /** 103-2: a camera reopen (off -> on) in flight; a second "on" waits for it. */
  private cameraReopening = false;
  /** 63-3: the fallback notice raised at join when the chosen mic was absent,
   * retracted once the device watch recaptures onto it. */
  private micFallbackNotice: string | null = null;
  // 63-2: speaking detection (the green audio dot).
  private speakTimer: number | null = null;
  private readonly speakTracker = new SpeakingTracker();
  /** Last played-out timestamp per receiver, to tell live audio from a
   * DTX-frozen source that stopped sending. */
  private readonly speakPrevTs = new WeakMap<RTCRtpReceiver, number>();
  private speakEmitted = "";
  /** Verified peer identities by userID; null = looked up, unusable. */
  private readonly identities = new Map<string, { ed25519Public: Uint8Array } | null>();
  /** Concurrent-join fallback timers by peer key. */
  private readonly glareTimers = new Map<string, number>();
  /** 30-4c/97-1: the bounded diagnostics event ring -- the session's when one
   * was handed in, else private (guest room). */
  private readonly ring: VoiceDiagRing;

  constructor(o: VoiceCallOptions) {
    this.o = o;
    this.selfKey = peerKey(o.selfUserID, o.selfDeviceID);
    this.ring = o.diag ?? new VoiceDiagRing();
  }

  get isJoined(): boolean {
    return this.joined;
  }

  get relayOnly(): boolean {
    return this.forceRelay;
  }

  get isSharingScreen(): boolean {
    return this.screenStream !== null;
  }

  get shareMode(): ScreenShareMode {
    return this.screenMode;
  }

  /** polite: perfect-negotiation role for a pair. Deterministic: the lower
   * key is impolite (keeps its offer), the higher is polite (rolls back). */
  private polite(peer: Peer): boolean {
    return this.selfKey > peer.key;
  }

  // ---- diagnostics surface (30-4c) ----------------------------------------

  /** diag records one event into the ring (which mirrors to the debug log). */
  private diag(msg: string): void {
    this.ring.push(msg);
  }

  /** diagnostics returns the call's half of the blob: config + last stats. */
  async diagnostics(): Promise<VoiceDiagnostics> {
    return {
      channelID: this.o.channelID,
      self: this.selfKey,
      forceRelay: this.forceRelay,
      net: {
        ...this.netPrefs,
        effectivePolicy: iceTransportPolicyFor(this.netPrefs, this.forceRelay),
      },
      iceServerURLs: this.iceServers.flatMap((s) =>
        Array.isArray(s.urls) ? s.urls : [s.urls as string],
      ),
      peers: await this.collectPeerStats(),
      adaptive: this.adaptiveDiag(),
      blur: this.blurStats?.(),
    };
  }

  /** adaptiveDiag: the planner's last plan, kbps-rounded (30-8). */
  private adaptiveDiag(): VoiceAdaptiveDiag | undefined {
    const p = this.lastPlan;
    if (!p) return undefined;
    const k = (bps: number): number => Math.round(bps / 1000);
    return {
      uplinkKbps: k(p.uplinkBps),
      probeKbps: this.probeBps === null ? null : k(this.probeBps),
      statsKbps: this.lastStatsBps === null ? null : k(this.lastStatsBps),
      videoBudgetKbps: k(p.videoBudgetBps),
      perCameraKbps: k(p.perCameraBps),
      perScreenKbps: k(p.perScreenBps),
      screenTier: this.appliedTier?.name ?? null,
    };
  }

  /** collectPeerStats snapshots every live pc: states + selected pair. */
  async collectPeerStats(): Promise<VoicePeerDiag[]> {
    const out: VoicePeerDiag[] = [];
    for (const peer of this.peers.values()) {
      const d: VoicePeerDiag = {
        key: peer.key,
        connectionState: peer.pc.connectionState,
        iceConnectionState: peer.pc.iceConnectionState,
        iceGatheringState: peer.pc.iceGatheringState,
        signalingState: peer.pc.signalingState,
      };
      try {
        d.pair = extractSelectedPair(await peer.pc.getStats());
      } catch {
        /* stats unavailable (pc closing) -- states alone still help */
      }
      out.push(d);
    }
    return out;
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * join captures local media, enters the room, and offers to every existing
   * participant from the ack roster.
   *
   * 30-5h: with the camera ON, it is acquired up front, so the panel's cam
   * toggle is an instant track.enabled flip rather than a renegotiation. If it
   * is denied or absent we degrade to audio-only.
   *
   * 66-2: with the camera OFF, it is not opened at all. It used to be acquired
   * up front regardless and merely left disabled -- nothing was published, but
   * the camera indicator lit up on every join, which is indistinguishable from
   * being on film for anyone who trusts the light more than our UI. Turning it
   * on mid-call now costs one renegotiation (enableCameraMidCall) and, the
   * first time, a camera permission prompt of its own. That is the price of
   * "off" meaning the device is not open.
   */
  async join(): Promise<void> {
    if (this.joined || this.closed) return;
    // Media first: if the mic is denied there is no point entering the room.
    //
    // 41-2: the mic is still captured together with the camera in ONE
    // getUserMedia -- asking separately would mean two permission prompts on a
    // user's first join. Only the audio half is then handed to the graph.
    this.micPrefs = loadMicPrefs();
    this.devicePrefs = loadDevicePrefs();
    // 63-3: map the saved mic (id + label) onto today's device list before
    // capturing; a saved device that is genuinely absent falls back to the
    // default WITH a note, instead of silently (macOS: the internal mic).
    const resolvedMic = await resolveMicPrefs(this.micPrefs);
    if (this.micPrefs.deviceId && !resolvedMic.deviceId) {
      this.diag(
        `chosen mic not present (${this.micPrefs.deviceLabel || this.micPrefs.deviceId}); using system default`,
      );
      const name = this.micPrefs.deviceLabel ? ` "${this.micPrefs.deviceLabel}"` : "";
      this.micFallbackNotice = `chosen microphone${name} not found — using the system default`;
      this.o.callbacks.onError(this.micFallbackNotice);
    }
    const audio = micConstraints(resolvedMic);
    let captured: MediaStream;
    if (this.o.startWithVideo) {
      const video = cameraConstraints(this.devicePrefs);
      try {
        captured = await navigator.mediaDevices.getUserMedia({ audio, video });
        this.hasVideo = captured.getVideoTracks().length > 0;
      } catch (err) {
        // Camera denied/absent but the mic may be fine: degrade to audio-only
        // rather than failing the join (design §8 permission handling). A bare
        // mic-denial still aborts.
        try {
          captured = await navigator.mediaDevices.getUserMedia({ audio });
          this.hasVideo = false;
          this.o.callbacks.onError(describeMediaError("camera", err) + " — joined audio-only");
        } catch (err2) {
          throw new Error(describeMediaError("microphone", err2));
        }
      }
    } else {
      // 66-2: camera off means the camera is never opened.
      try {
        captured = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (err) {
        throw new Error(describeMediaError("microphone", err));
      }
      this.hasVideo = false;
    }

    // Each graph takes ownership of its half of the capture. If either cannot
    // be built, publish that half raw -- a call without a gain slider or
    // without a mid-call camera swap still beats no call.
    const micStream = new MediaStream(captured.getAudioTracks());
    try {
      this.micChain = await MicChain.fromStream(micStream, this.micPrefs);
      this.micChain.onGateChange((open) => this.o.callbacks.onMicGate?.(open));
    } catch (err) {
      this.diag(`mic graph unavailable, publishing raw capture: ${String(err)}`);
    }
    const cameraTracks = captured.getVideoTracks();
    if (cameraTracks.length > 0) {
      try {
        this.cameraChain = CameraChain.fromStream(new MediaStream(cameraTracks));
        // 52-1: not awaited -- a driver that is slow to answer the constraint
        // must not hold up the join behind it, and the camera starts disabled
        // anyway, so the blur is in place well before a frame is published.
        void this.applyBackgroundBlur(this.devicePrefs.backgroundBlur);
      } catch (err) {
        this.diag(`camera graph unavailable, publishing raw capture: ${String(err)}`);
      }
    }
    this.localStream = new MediaStream([
      this.micChain ? this.micChain.track : micStream.getAudioTracks()[0],
      ...(this.cameraChain ? [this.cameraChain.track] : cameraTracks),
    ]);
    // Every join starts with the video track disabled and the graph parked,
    // even when a camera was acquired: the session enables it once the join is
    // through, so a failed join never publishes a frame. With 66-2's audio-only
    // join there is simply nothing here to disable.
    this.videoEnabled = false;
    for (const t of this.localStream.getVideoTracks()) t.enabled = false;
    this.cameraChain?.setActive(false);
    this.o.callbacks.onLocalStream(this.localStream);

    let ack: VoiceJoinAckPayload;
    try {
      ack = await this.o.transport.request<{ channel_id: string }, VoiceJoinAckPayload>(
        TypeVoiceJoin,
        { channel_id: this.o.channelID },
      );
    } catch (err) {
      this.stopLocalMedia();
      throw err;
    }
    this.iceServers = (ack.ice_servers ?? []).map(iceServerFromWire);
    this.forceRelay = !!ack.force_relay;
    this.joined = true;
    this.diag(
      `join ack: roster=${(ack.roster ?? []).length} ice_servers=${this.iceServers.length}` +
        ` force_relay=${this.forceRelay}`,
    );
    // 30-8: adaptive policy + the pre-stream probe (D1). The probe fires
    // NOW -- concurrent with the signaling handshake but before real media
    // bandwidth ramps (GCC starts each stream at ~15% and climbs over
    // ~30 s, so the seconds-long probe finishes before media competes).
    this.adaptiveCfg = parseAdaptiveWire(ack.adaptive);
    if (this.adaptiveCfg.probeEnabled) {
      void probeUplink(this.adaptiveCfg.probeBytes).then((bps) => {
        if (this.closed) return;
        this.probeBps = bps;
        this.diag(
          bps === null
            ? "uplink probe failed — planning from stats + fallback"
            : `uplink probe: ≈${Math.round(bps / 1000)} kbps`,
        );
        this.applyBudget();
      });
    }
    this.startAdaptiveTimers();
    this.startSpeakingPoll();
    this.startDeviceWatch();
    // 30-5h: camera starts OFF and mic starts UNMUTED, both matching the
    // server's default participant row (muted=false, video_on=false), so no
    // post-join state broadcast is needed -- the roster badges are already
    // correct. Toggling either later broadcasts via setMuted/setVideoEnabled.

    // Glare-free: the joiner (us) offers to exactly the ack roster.
    for (const p of ack.roster ?? []) {
      const key = peerKey(p.user_id, p.device_id);
      if (key === this.selfKey) continue; // server excludes us, but be safe
      this.diag(`offering to existing peer ${key}`);
      this.enqueue(this.ensurePeer(p.user_id, p.device_id), (peer) => this.offerTo(peer));
    }
  }

  /** leave exits the room and tears everything down. Idempotent. */
  async leave(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const wasJoined = this.joined;
    this.joined = false;
    this.stopAdaptiveTimers();
    this.stopSpeakingPoll();
    this.stopDeviceWatch();
    for (const t of this.glareTimers.values()) window.clearTimeout(t);
    this.glareTimers.clear();
    for (const key of [...this.peers.keys()]) this.dropPeer(key, false);
    this.stopLocalMedia();
    if (wasJoined && this.o.transport.isOpen()) {
      try {
        await this.o.transport.request(TypeVoiceLeave, { channel_id: this.o.channelID });
      } catch {
        // Best-effort: the server also cleans up by conn_id on disconnect.
      }
    }
  }

  // ---- local media toggles -------------------------------------------------

  /**
   * setMuted gates the mic and broadcasts voice_state.
   *
   * 41-2: the gating happens at the RAW capture inside the chain, not on the
   * published track -- see MicChain.setMuted. The fallback covers a chain that
   * failed to build, where localStream carries the raw track directly.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.micChain) this.micChain.setMuted(muted);
    else for (const t of this.localStream?.getAudioTracks() ?? []) t.enabled = !muted;
    this.broadcastState();
  }

  /**
   * setAudioState (109-1) sets mute and deafen together, in one broadcast.
   *
   * Deafening always moves both -- it mutes you with it, and un-deafening
   * restores the mute you had before -- so setting them separately would put
   * a frame on the wire claiming a state that existed for no time at all
   * (deafened but still unmuted). Everything mute-only stays on setMuted.
   */
  setAudioState(muted: boolean, deafened: boolean): void {
    this.deafened = deafened;
    this.setMuted(muted);
  }

  /**
   * applyMicPrefs (41-4) pushes a profile-panel change into the live call.
   *
   * Gain is a graph parameter and applies instantly. The device and the
   * processing flags are properties of the capture, so they need a new
   * getUserMedia -- but because the published track belongs to the graph's
   * destination node, swapping the mic underneath needs NO renegotiation and
   * no replaceTrack on any peer. If the new capture fails (device unplugged,
   * busy, permission revoked) the old one is kept and the user is told.
   */
  async applyMicPrefs(next: MicPrefs): Promise<void> {
    if (this.closed || !this.micChain) return;
    const prev = this.micPrefs;
    this.micPrefs = next;
    this.micChain.setGain(next.gain);
    if (!needsRecapture(prev, next)) return;
    try {
      await this.micChain.recapture(next);
      this.diag(`mic recaptured: device=${next.deviceId || "default"}`);
    } catch (err) {
      this.micPrefs = prev;
      this.o.callbacks.onError(
        describeMediaError("microphone", err) + " — kept the previous microphone",
      );
    }
  }

  /**
   * applyDevicePrefs (44-9) pushes a camera change into the live call.
   *
   * The output device is not handled here: playback belongs to the <audio>
   * elements the dock owns, and this class never touches them.
   *
   * 44-10: the swap is now entirely inside the camera graph. The published
   * track belongs to the graph's canvas, so changing the device behind it
   * touches no sender, no SDP and no peer connection -- where this used to
   * fan replaceTrack out across every peer and race the negotiation queue,
   * there is now nothing to coordinate.
   */
  async applyDevicePrefs(next: DevicePrefs): Promise<void> {
    if (this.closed) return;
    const prev = this.devicePrefs;
    this.devicePrefs = next;
    if (prev.backgroundBlur !== next.backgroundBlur) {
      await this.applyBackgroundBlur(next.backgroundBlur);
    }
    if (prev.cameraId === next.cameraId) return;
    // No graph: either an audio-only join (which picks the new camera up when
    // the mid-call add acquires) or the raw-publish fallback, where there is
    // no stable published track to swap behind. A fresh join reads the pref
    // outright either way.
    if (!this.cameraChain) return;
    // 103-2: camera off means the device is released; the reopen reads the
    // pref when the camera comes back, and opening it now just to honour a
    // picker change would light the indicator behind an "off" button.
    if (this.cameraChain.deviceReleased) {
      this.diag(`camera pref changed while off: device=${next.cameraId || "default"} (applied on reopen)`);
      return;
    }

    try {
      await this.cameraChain.recapture(next);
    } catch (err) {
      this.devicePrefs = prev;
      this.o.callbacks.onError(describeMediaError("camera", err) + " — kept the previous camera");
      return;
    }
    this.diag(`camera switched: device=${next.cameraId || "default"}`);
  }

  /**
   * applyBackgroundBlur (52-1) puts the current preference into effect on the
   * live camera graph.
   *
   * Called on every path that produces a graph -- the join, the mid-call camera
   * add, and the toggle itself -- because each of those hands us a camera that
   * knows nothing about the preference.
   *
   * A machine where nothing can blur logs it and carries on: the wish stays
   * stored for the machine that can honour it, and a call is not the place to
   * argue with someone about their hardware. 52-2 is what makes this reach the
   * other case, by falling back to a frame processor when native declines.
   */
  private async applyBackgroundBlur(on: boolean): Promise<void> {
    const chain = this.cameraChain;
    if (!chain) return;
    // Loading is ~12 MB on first use, so this can take a moment on a slow
    // link. Nothing waits on it: the call runs unblurred until it lands, which
    // is honest, and the camera is usually still off this early anyway.
    try {
      const { plan, stats } = await applyBlurTo(chain, on, {
        stillWanted: () =>
          !this.closed && this.devicePrefs.backgroundBlur && this.cameraChain === chain,
        onGiveUp: (err) => {
          // Reached two ways: the chain gave up on a processor that kept
          // throwing (52-1), and the processor giving up on a machine it
          // cannot keep pace with (52-3). Clearing the chain covers the second
          // -- the first has already done it -- and setProcessor(null) is a
          // no-op when it is already gone, so the two need no telling apart.
          this.cameraChain?.setProcessor(null);
          this.blurStats = null;
          this.o.callbacks.onError("background blur stopped — your camera is unblurred");
          this.diag(`background blur dropped: ${String(err)}`);
        },
      });
      if (stats) this.blurStats = stats;
      else if (plan !== "processor") this.blurStats = null;
      this.diag(
        plan === "processor"
          ? "background blur on: local segmentation"
          : `background blur: ${plan === "native" ? "camera" : "off"}`,
      );
    } catch (err) {
      this.o.callbacks.onError("couldn't start background blur — your camera is unblurred");
      this.diag(`background blur unavailable: ${String(err)}`);
    }
  }

  /**
   * applyNetPrefs pushes a debug-drawer transport change into the live call.
   *
   * The candidate filters take effect at once, on everything gathered or
   * received from here on. The transport policy is handed to every live
   * peer connection, but a browser only consults it while gathering, so an
   * already-negotiated peer keeps the path it picked: the honest way to make
   * relay-only bite for peers that are already up is to rejoin, which is what
   * the drawer tells the user.
   */
  applyNetPrefs(next: NetPrefs): void {
    if (this.closed) return;
    const prev = this.netPrefs;
    this.netPrefs = next;
    const policy = iceTransportPolicyFor(next, this.forceRelay);
    if (iceTransportPolicyFor(prev, this.forceRelay) !== policy) {
      for (const peer of this.peers.values()) {
        try {
          peer.pc.setConfiguration({
            iceServers: this.iceServers,
            iceTransportPolicy: policy,
          });
        } catch (err) {
          // Not every browser allows narrowing the policy on a live pc.
          console.warn("setConfiguration:", err);
        }
      }
    }
    this.diag(
      `net prefs: transport=${next.transport} (effective ${policy})` +
        ` ipv4Only=${next.ipv4Only} noHost=${next.noHost}`,
    );
  }

  /** The current mic level, 0..1, post-gain. Null when there is no capture. */
  micLevel(): number | null {
    return this.micChain ? this.micChain.level() : null;
  }

  /** setKeyHeld reports the push-to-talk / push-to-mute key to the gate. */
  setKeyHeld(held: boolean): void {
    this.micChain?.setKeyHeld(held);
  }

  /**
   * setVideoEnabled flips the camera track on/off without renegotiating: the
   * published track is the graph's canvas capture and stays in every pc
   * (30-5h). Returns false only when the join degraded to audio-only, i.e.
   * there is no camera track (adding one mid-call needs renegotiation, 30-7).
   *
   * 103-2: "off" now also RELEASES the device. Disabling the published track
   * turns the far end black; parking the graph stops the draw loop; and
   * stopping the raw capture puts the camera indicator out, which is the
   * only signal a user trusts (66-2 made the same call for the join). "On"
   * reopens the device behind the still-published canvas track, so the far
   * end sees black for the reacquire's few hundred ms and then frames --
   * no offer/answer either way. Only the raw-publish fallback (no graph)
   * keeps holding the device while disabled: there is no canvas to hide
   * behind.
   */
  setVideoEnabled(on: boolean): boolean {
    if (!this.hasVideo) return false;
    this.videoEnabled = on;
    for (const t of this.localStream?.getVideoTracks() ?? []) t.enabled = on;
    if (this.cameraChain) {
      if (on) {
        void this.reopenCamera(this.cameraChain);
      } else {
        this.cameraChain.setActive(false);
        this.cameraChain.releaseDevice();
      }
    }
    this.applyBudget(); // 30-8: camera copies enter/leave the divider
    this.broadcastState();
    return true;
  }

  /**
   * reopenCamera (103-2) brings a released device back for setVideoEnabled.
   * Toggles during the reacquire are honoured by reading videoEnabled once
   * it lands: off again -> release again, still on -> un-park the graph. A
   * reacquire that fails (device unplugged, taken by another app) leaves the
   * camera off and tells the session so its button follows.
   */
  private async reopenCamera(chain: CameraChain): Promise<void> {
    if (!chain.deviceReleased) {
      chain.setActive(true);
      return;
    }
    if (this.cameraReopening) return;
    this.cameraReopening = true;
    let failed: unknown = null;
    try {
      await chain.recapture(this.devicePrefs);
    } catch (err) {
      failed = err ?? new Error("camera reopen failed");
    } finally {
      this.cameraReopening = false;
    }
    if (this.closed || this.cameraChain !== chain) return;
    if (failed !== null) {
      this.diag(`camera reopen failed: ${String(failed)}`);
      this.videoEnabled = false;
      for (const t of this.localStream?.getVideoTracks() ?? []) t.enabled = false;
      this.o.callbacks.onError(describeMediaError("camera", failed) + " — camera stays off");
      this.o.callbacks.onCameraLost?.();
      this.applyBudget();
      this.broadcastState();
      return;
    }
    if (!this.videoEnabled) {
      chain.releaseDevice();
      return;
    }
    chain.setActive(true);
    // The fresh device knows nothing about the blur preference (52-1).
    void this.applyBackgroundBlur(this.devicePrefs.backgroundBlur);
    this.diag("camera reopened");
  }

  get joinedWithVideo(): boolean {
    return this.hasVideo;
  }

  private broadcastState(): void {
    if (!this.joined || !this.o.transport.isOpen()) return;
    this.o.transport
      .request(TypeVoiceState, {
        channel_id: this.o.channelID,
        muted: this.muted,
        video_on: this.hasVideo && this.videoEnabled,
        screen_on: this.screenStream !== null, // 30-7a
        deafened: this.deafened, // 109-1
      })
      .catch((err) => console.warn("voice_state:", err));
  }

  // ---- inbound frames ------------------------------------------------------

  /**
   * handleFrame feeds the manager the voice frames App routed onto the bus.
   * Frames for other channels are ignored here (App doesn't pre-filter).
   */
  handleFrame(f: Frame): void {
    if (this.closed) return;
    switch (f.type) {
      case TypeVoiceSignal: {
        const p = f.payload as VoiceSignalPushPayload;
        if (!p || p.channel_id !== this.o.channelID) return;
        if (peerKey(p.from_user, p.from_device) === this.selfKey) return;
        this.onSignal(p);
        return;
      }
      case TypeVoiceParticipantJoined: {
        const p = f.payload as VoiceParticipantJoinedPayload;
        if (!p || p.channel_id !== this.o.channelID || !this.joined) return;
        const key = peerKey(p.user_id, p.device_id);
        if (key === this.selfKey || this.peers.has(key)) return;
        // Existing side of the handshake: normally just WAIT for the
        // joiner's offer. Concurrent-join fallback: after a grace period,
        // the deterministic lower key offers (see file header).
        if (this.selfKey < key && !this.glareTimers.has(key)) {
          const t = window.setTimeout(() => {
            this.glareTimers.delete(key);
            if (this.closed || !this.joined || this.peers.has(key)) return;
            this.enqueue(this.ensurePeer(p.user_id, p.device_id), (peer) =>
              this.offerTo(peer),
            );
          }, JOIN_GLARE_FALLBACK_MS);
          this.glareTimers.set(key, t);
        }
        return;
      }
      case TypeVoiceParticipantLeft: {
        const p = f.payload as VoiceParticipantLeftPayload;
        if (!p || p.channel_id !== this.o.channelID) return;
        const key = peerKey(p.user_id, p.device_id);
        const t = this.glareTimers.get(key);
        if (t !== undefined) {
          window.clearTimeout(t);
          this.glareTimers.delete(key);
        }
        if (this.peers.has(key)) this.dropPeer(key, true);
        return;
      }
      default:
        return;
    }
  }

  // ---- peers ---------------------------------------------------------------

  private ensurePeer(userID: string, deviceID: string): Peer {
    const key = peerKey(userID, deviceID);
    const existing = this.peers.get(key);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      // §7d: relay-only proves the no-P2P path. The device can force relay for
      // itself too (debug drawer); it can never relax a server force_relay.
      iceTransportPolicy: iceTransportPolicyFor(this.netPrefs, this.forceRelay),
    });
    const peer: Peer = {
      key,
      userID,
      deviceID,
      pc,
      pendingIce: [],
      hasRemoteDesc: false,
      chain: Promise.resolve(),
      makingOffer: false,
      ignoreOffer: false,
      screenStreamIDs: new Set(),
      cameraStreamID: null,
      pendingStreams: new Map(),
      troubleSnap: null,
    };
    this.peers.set(key, peer);

    for (const track of this.localStream?.getTracks() ?? []) {
      pc.addTrack(track, this.localStream!);
    }
    // 103-1: a camera-off join publishes no video track (66-2), so without
    // this our OFFER carries no video m-line -- and an answer cannot add one.
    // The far side's camera sender then never gets negotiated in until WE
    // turn a camera on (enableCameraMidCall's offer finally has the m-line),
    // which is the "I only see them once my own cam is on" bug. A recvonly
    // transceiver gives every offer the m-line; their sender associates with
    // it and answers sendonly. addTrack later reuses this transceiver, so the
    // mid-call camera add still costs one renegotiation and no extra m-line.
    if ((this.localStream?.getVideoTracks().length ?? 0) === 0) {
      pc.addTransceiver("video", { direction: "recvonly" });
    }

    pc.ontrack = (e) => {
      this.diag(`ontrack from ${key}: kind=${e.track.kind} streams=${e.streams.length}`);
      const stream = e.streams[0];
      if (!stream) return;
      // 30-7a routing: a screen_add-announced stream id renders as a screen
      // tile; the first (or repeated) non-screen stream is the camera/mic.
      // An UNKNOWN second stream raced ahead of its announce -- buffer it;
      // the screen_add handler flushes it. (Ordering normally prevents
      // this: the announce and the offer ride the same per-peer op chain
      // over the same ordered relay.)
      if (peer.screenStreamIDs.has(stream.id)) {
        this.o.callbacks.onPeerScreenStream(key, userID, deviceID, stream);
        return;
      }
      if (peer.cameraStreamID === null || peer.cameraStreamID === stream.id) {
        peer.cameraStreamID = stream.id;
        this.o.callbacks.onPeerStream(key, userID, deviceID, stream);
        return;
      }
      this.diag(`unannounced extra stream from ${key} buffered (id=${stream.id})`);
      peer.pendingStreams.set(stream.id, stream);
    };
    pc.onicecandidate = (e) => {
      // The device's candidate filters (debug drawer): never advertise a path
      // this machine has been told is useless -- e.g. the non-routable IPv6 ULA
      // interface of a VM/VPN bridge, whose TURN host lookups fail.
      if (e.candidate && shouldDropCandidate(e.candidate.candidate, this.netPrefs)) {
        this.diag(`dropped local ${candidateTypeOf(e.candidate.candidate)} candidate for ${key}`);
        return;
      }
      this.diag(
        e.candidate
          ? `gathered candidate for ${key}: ${candidateTypeOf(e.candidate.candidate)}`
          : `candidate gathering done for ${key}`,
      );
      // Trickle: each candidate (and the null end-marker) rides encrypted.
      const body: IceSignal = { candidate: e.candidate ? e.candidate.toJSON() : null };
      void this.sendSignal(peer, "ice", body);
    };
    // 97-2: the ICE layer's own transitions, logged independently.
    // "disconnected" often precedes a failure (or a recovery) by seconds and
    // is the moment worth a stats snapshot -- the pc is still open, so the
    // selected pair (relay vs direct, rtt, byte counters) is still readable;
    // by the time connectionState says "failed" it is often already gone.
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      this.diag(`ice state ${key} = ${st}`);
      if (st === "disconnected" || st === "failed") {
        this.snapshotTroublePair(peer, st);
      } else if (st === "connected" || st === "completed") {
        peer.troubleSnap = null; // recovered -- the next episode snapshots again
      }
    };
    pc.onconnectionstatechange = () => {
      this.diag(`conn state ${key} = ${pc.connectionState} (ice=${pc.iceConnectionState})`);
      this.o.callbacks.onPeerState(key, pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        // 97-2: last chance to read the stats -- dropPeer closes the pc.
        // The getStats call is issued synchronously here; the troubleSnap
        // guard makes this a no-op when the ICE handler already took it.
        if (pc.connectionState === "failed") this.snapshotTroublePair(peer, "failed");
        // v1 reconnection policy (design §9): no automatic ICE restart;
        // the peer either re-offers (rejoin) or the roster push removes it.
        this.dropPeer(key, true);
      }
    };

    this.applyBudget();
    return peer;
  }

  /** 97-2: one-shot getStats when a peer link degrades. The drawer's live
   * stats only run while it is open, and nobody has it open when a call
   * unexpectedly dies -- so the ring itself records what the path looked
   * like at that moment. Deduped per state per episode via troubleSnap. */
  private snapshotTroublePair(peer: Peer, state: string): void {
    if (peer.troubleSnap === state) return;
    peer.troubleSnap = state;
    void peer.pc.getStats().then(
      (report) => {
        const pair = extractSelectedPair(report);
        this.diag(
          pair
            ? `pair at ${state} for ${peer.key}: ${describePair(pair)}`
            : `pair at ${state} for ${peer.key}: none selected`,
        );
      },
      () => this.diag(`pair at ${state} for ${peer.key}: stats unavailable`),
    );
  }

  private dropPeer(key: string, notify: boolean): void {
    const peer = this.peers.get(key);
    if (!peer) return;
    this.peers.delete(key);
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    peer.pc.oniceconnectionstatechange = null;
    peer.pc.onconnectionstatechange = null;
    try {
      peer.pc.close();
    } catch {
      /* already closed */
    }
    if (notify) this.o.callbacks.onPeerGone(key);
    this.applyBudget();
  }

  /** enqueue serializes an async op on the peer's signaling chain. */
  private enqueue(peer: Peer, op: (p: Peer) => Promise<void>): void {
    peer.chain = peer.chain
      .then(() => (this.peers.get(peer.key) === peer ? op(peer) : undefined))
      .catch((err) => {
        console.error(`voice peer ${peer.key}:`, err);
        this.o.callbacks.onError(`call setup with a peer failed: ${String(err)}`);
      });
  }

  // ---- signaling: outbound -------------------------------------------------

  private fpContextTo(peer: Peer): FingerprintContext {
    return {
      channelID: this.o.channelID,
      fromUser: this.o.selfUserID,
      fromDevice: this.o.selfDeviceID,
      toUser: peer.userID,
      toDevice: peer.deviceID,
    };
  }

  private fpContextFrom(peer: Peer): FingerprintContext {
    return {
      channelID: this.o.channelID,
      fromUser: peer.userID,
      fromDevice: peer.deviceID,
      toUser: this.o.selfUserID,
      toDevice: this.o.selfDeviceID,
    };
  }

  /** offerTo: an initial/explicit offer, carrying the active screen share
   * (if any) so a peer we dial while sharing gets the screen m-lines in the
   * FIRST negotiation instead of an immediate renegotiation. */
  private async offerTo(peer: Peer): Promise<void> {
    await this.attachScreenTracks(peer);
    await this.sendOffer(peer);
  }

  private async sendOffer(peer: Peer): Promise<void> {
    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer();
      // A colliding offer can win while createOffer was in flight (the
      // polite side's implicit rollback). Setting a stale local offer would
      // throw; skip -- the pair is already renegotiating under their offer.
      if (peer.pc.signalingState !== "stable") {
        this.diag(`offer to ${peer.key} superseded (state=${peer.pc.signalingState})`);
        return;
      }
      await peer.pc.setLocalDescription(offer);
      const sdp = peer.pc.localDescription?.sdp ?? offer.sdp ?? "";
      const fpSig = await signFingerprints(
        this.o.ed25519Private,
        this.fpContextTo(peer),
        extractFingerprints(sdp),
      );
      const body: SdpSignal = { sdp, fp_sig: fpSig };
      await this.sendSignal(peer, "offer", body);
    } finally {
      peer.makingOffer = false;
    }
  }

  private async sendAnswer(peer: Peer): Promise<void> {
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    const sdp = peer.pc.localDescription?.sdp ?? answer.sdp ?? "";
    const fpSig = await signFingerprints(
      this.o.ed25519Private,
      this.fpContextTo(peer),
      extractFingerprints(sdp),
    );
    const body: SdpSignal = { sdp, fp_sig: fpSig };
    await this.sendSignal(peer, "answer", body);
  }

  private async sendSignal(peer: Peer, kind: string, obj: unknown): Promise<void> {
    const sealed = await sealSignal(this.o.crypto, this.o.channelID, obj);
    if (!sealed) {
      // Fail-closed (no plaintext fallback): without the space key we cannot
      // signal at all. Surfaced once; the join gate in the panel makes this
      // effectively unreachable.
      this.o.callbacks.onError("channel key not available — cannot signal");
      return;
    }
    if (!this.o.transport.isOpen()) return;
    this.diag(`send ${kind} -> ${peer.key}`);
    try {
      this.o.transport.send<VoiceSignalSendPayload>(TypeVoiceSignal, {
        channel_id: this.o.channelID,
        to_user: peer.userID,
        to_device: peer.deviceID,
        kind,
        payload: sealed,
      });
    } catch (err) {
      console.warn("voice signal send:", err);
    }
  }

  // ---- signaling: inbound --------------------------------------------------

  private onSignal(p: VoiceSignalPushPayload): void {
    const key = peerKey(p.from_user, p.from_device);
    this.diag(`recv ${p.kind} <- ${key}`);
    // An offer may create the peer; answer/ice for an unknown peer is stale.
    if (p.kind !== "offer" && !this.peers.has(key)) return;
    const t = this.glareTimers.get(key);
    if (t !== undefined) {
      window.clearTimeout(t);
      this.glareTimers.delete(key);
    }
    const peer = this.ensurePeer(p.from_user, p.from_device);
    this.enqueue(peer, async (pr) => {
      const opened = await openSignal(this.o.crypto, this.o.channelID, p.payload as SealedSignal);
      if (opened === null) {
        this.o.callbacks.onError("could not decrypt a signaling message from a peer");
        return;
      }
      switch (p.kind) {
        case "offer":
          await this.onOffer(pr, opened as SdpSignal);
          return;
        case "answer":
          await this.onAnswer(pr, opened as SdpSignal);
          return;
        case "ice":
          await this.onIce(pr, opened as IceSignal);
          return;
        case "screen_add":
          this.onScreenAdd(pr, opened as ScreenSignal);
          return;
        case "screen_remove":
          this.onScreenRemove(pr, opened as ScreenSignal);
          return;
        default:
          return;
      }
    });
  }

  /** verifySdp checks Slice F: signature over the SDP's fingerprints. */
  private async verifySdp(peer: Peer, sig: SdpSignal): Promise<boolean> {
    if (!sig || typeof sig.sdp !== "string" || typeof sig.fp_sig !== "string") return false;
    let ident = this.identities.get(peer.userID);
    if (ident === undefined) {
      const fetched = await fetchIdentity(this.o.transport, peer.userID);
      ident = fetched ? { ed25519Public: fetched.ed25519Public } : null;
      this.identities.set(peer.userID, ident);
    }
    if (!ident) return false; // no published/verifiable identity -> unusable
    return verifyFingerprints(
      ident.ed25519Public,
      this.fpContextFrom(peer),
      extractFingerprints(sig.sdp),
      sig.fp_sig,
    );
  }

  private async onOffer(peer: Peer, sig: SdpSignal): Promise<void> {
    if (!(await this.verifySdp(peer, sig))) {
      this.abortPeer(peer, "identity check failed on an incoming offer (possible MITM)");
      return;
    }
    // Perfect negotiation (B2). Collision = their offer landed while ours
    // is in flight or unresolved. Impolite (lower key) ignores theirs; the
    // polite side's setRemoteDescription performs an implicit rollback of
    // its own outstanding offer. A non-colliding offer on a STABLE pair is
    // a plain renegotiation (screen add/remove) and just gets answered.
    const collision =
      peer.makingOffer || peer.pc.signalingState !== "stable";
    peer.ignoreOffer = !this.polite(peer) && collision;
    if (peer.ignoreOffer) {
      this.diag(`ignored colliding offer from ${peer.key} (impolite)`);
      return;
    }
    await peer.pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
    this.diag(`applied remote offer from ${peer.key}${collision ? " (rolled back own)" : ""}`);
    peer.hasRemoteDesc = true;
    await this.drainIce(peer);
    await this.sendAnswer(peer);
    // If we are sharing and this peer's pc doesn't carry the screen tracks
    // yet (e.g. it just [re]joined and offered to us first), renegotiate
    // them in now that the pair is stable. Idempotent via the sender check.
    if (this.screenStream && (await this.attachScreenTracks(peer))) {
      await this.sendOffer(peer);
    }
  }

  private async onAnswer(peer: Peer, sig: SdpSignal): Promise<void> {
    if (peer.pc.signalingState !== "have-local-offer") return; // stale
    if (!(await this.verifySdp(peer, sig))) {
      this.abortPeer(peer, "identity check failed on an incoming answer (possible MITM)");
      return;
    }
    await peer.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });
    this.diag(`applied remote answer from ${peer.key}`);
    peer.hasRemoteDesc = true;
    await this.drainIce(peer);
  }

  private async onIce(peer: Peer, sig: IceSignal): Promise<void> {
    if (!sig || sig.candidate === undefined) return;
    // Mirror the local filter onto the peer's candidates: pairing against an
    // address this device has been told is unreachable just wastes checks.
    if (sig.candidate && shouldDropCandidate(sig.candidate.candidate ?? "", this.netPrefs)) {
      return;
    }
    if (!peer.hasRemoteDesc) {
      if (sig.candidate !== null) peer.pendingIce.push(sig.candidate);
      return;
    }
    try {
      if (sig.candidate === null) {
        await peer.pc.addIceCandidate();
      } else {
        await peer.pc.addIceCandidate(sig.candidate);
      }
    } catch (err) {
      // Individual candidate failures are survivable; ICE keeps going.
      // While we ignore a colliding offer, its trailing candidates failing
      // is EXPECTED (perfect negotiation) -- don't even warn.
      if (!peer.ignoreOffer) console.warn("addIceCandidate:", err);
    }
  }

  private async drainIce(peer: Peer): Promise<void> {
    const queued = peer.pendingIce.splice(0);
    for (const c of queued) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch (err) {
        console.warn("addIceCandidate (queued):", err);
      }
    }
  }

  /** abortPeer tears a peer down loudly -- the Slice F MITM reaction. */
  private abortPeer(peer: Peer, why: string): void {
    this.diag(`ABORT ${peer.key}: ${why}`);
    this.o.callbacks.onError(why);
    this.dropPeer(peer.key, true);
  }

  // ---- screen share (30-7a, Addendum B) ------------------------------------

  /**
   * startScreenShare captures a display surface and renegotiates it into
   * every live pc as SEPARATE transceivers (camera/mic untouched, B1).
   * 30-7a fixes the mode to "detail" (crisp screen); the 3-way Prioritize
   * toggle, codec ladder and shared app audio land in 30-7b.
   *
   * Returns false when not in a call, already sharing, or the user
   * cancelled the browser picker (cancel is not an error).
   */
  async startScreenShare(): Promise<boolean> {
    if (!this.joined || this.closed || this.screenStream) return false;
    let stream: MediaStream;
    try {
      // B6 picker hints: exclude our own tab (hall-of-mirrors), offer
      // system/tab audio, allow switching the shared surface, list
      // monitors. All advisory; browsers ignore what they don't know.
      const opts: MediaStreamConstraints & {
        selfBrowserSurface?: string;
        systemAudio?: string;
        surfaceSwitching?: string;
        monitorTypeSurfaces?: string;
      } = {
        video: this.screenCaptureConstraints(),
        // B3 shared app/game audio -- feature-detected by the platform:
        // Chromium returns a tab/system audio track when the user ticks
        // the box; Firefox/Safari simply return video-only.
        audio: true,
        selfBrowserSurface: "exclude",
        systemAudio: "include",
        surfaceSwitching: "include",
        monitorTypeSurfaces: "include",
      };
      stream = await navigator.mediaDevices.getDisplayMedia(opts);
    } catch (err) {
      const name = (err as DOMException)?.name ?? "";
      if (name === "NotAllowedError" || name === "AbortError") {
        // Picker dismissed / OS screen-recording permission missing.
        if (name === "NotAllowedError") {
          this.o.callbacks.onError(
            "screen capture was not allowed — if you did pick a screen, grant the browser screen-recording permission in the OS settings",
          );
        }
        return false;
      }
      this.o.callbacks.onError(`screen capture failed: ${String((err as Error)?.message ?? err)}`);
      return false;
    }
    const video = stream.getVideoTracks()[0];
    if (!video) {
      for (const t of stream.getTracks()) t.stop();
      return false;
    }
    // B0: the mode's contentHint on the track (degradationPreference is
    // pinned explicitly per sender in applyBudget too, not just implied).
    video.contentHint = this.screenMode;
    // Shared audio is PROGRAM audio: "music" keeps the encoder from
    // treating it as speech; it must never enter a mic processing graph.
    for (const a of stream.getAudioTracks()) a.contentHint = "music";
    // The browser's own "Stop sharing" bar ends the track outside our UI --
    // mirror it into a full stop so peers and roster stay honest.
    video.addEventListener("ended", () => {
      void this.stopScreenShare();
    });
    this.screenStream = stream;
    this.diag(`screen share started (stream=${stream.id})`);
    for (const peer of this.peers.values()) {
      this.enqueue(peer, async (pr) => {
        if (await this.attachScreenTracks(pr)) await this.sendOffer(pr);
      });
    }
    this.broadcastState();
    this.o.callbacks.onLocalScreenStream(stream);
    return true;
  }

  /** stopScreenShare removes the screen senders from every pc (with a
   * renegotiation each), announces screen_remove, and stops capture.
   * Idempotent; also invoked by the track's own "ended" event. */
  async stopScreenShare(): Promise<void> {
    const stream = this.screenStream;
    if (!stream) return;
    this.screenStream = null;
    const trackIDs = new Set(stream.getTracks().map((t) => t.id));
    this.diag(`screen share stopped (stream=${stream.id})`);
    for (const peer of this.peers.values()) {
      this.enqueue(peer, async (pr) => {
        let removed = false;
        for (const sender of pr.pc.getSenders()) {
          if (sender.track && trackIDs.has(sender.track.id)) {
            try {
              pr.pc.removeTrack(sender);
              removed = true;
            } catch {
              /* pc closing -- nothing to renegotiate */
            }
          }
        }
        await this.sendSignal(pr, "screen_remove", {
          stream_id: stream.id,
        } satisfies ScreenSignal);
        if (removed) await this.sendOffer(pr);
      });
    }
    for (const t of stream.getTracks()) t.stop();
    this.appliedScreenCodec = null;
    // 30-8: the next share re-seeds its rung from a fresh observation.
    this.screenLadder.reset();
    this.appliedTier = null;
    this.appliedCaptureFps = null;
    this.pauseWarned = false;
    this.applyBudget();
    if (!this.closed) this.broadcastState();
    this.o.callbacks.onLocalScreenStream(null);
  }

  /** screenCaptureConstraints: the B3 capture shape for the current mode.
   * motion = high fps (resolution yields under pressure); detail/text =
   * low fps, full resolution. Also applied live on a mode flip. */
  private screenCaptureConstraints(): MediaTrackConstraints {
    return this.screenMode === "motion"
      ? { frameRate: { ideal: 60, max: 60 } }
      : { frameRate: { ideal: 15, max: 30 } };
  }

  /**
   * setScreenShareMode (B0): flip the share's priority live -- no
   * re-capture, no picker. hint + fps constraint + bitrate/degradation
   * (applyBudget) all apply in place; the codec is renegotiated only when
   * the mode's ladder actually changes the chosen family.
   */
  setScreenShareMode(mode: ScreenShareMode): void {
    this.screenMode = mode;
    // 30-8: the mode picks the ladder column (D3); re-seed from the next
    // budget observation rather than mapping rungs across ladders.
    this.screenLadder.switchLadder(ladderFor(mode));
    this.appliedCaptureFps = null;
    const stream = this.screenStream;
    if (!stream) return; // sticky for the next share
    const video = stream.getVideoTracks()[0];
    if (video) {
      video.contentHint = mode;
      video.applyConstraints(this.screenCaptureConstraints()).catch((err) => {
        // Constraint rejection degrades quality, not correctness.
        console.warn("share mode applyConstraints:", err);
      });
    }
    this.applyBudget();
    this.diag(`share mode -> ${mode}`);
    // Codec: renegotiate only on a real ranking change (B3).
    const ranked = this.rankedScreenCodecs();
    if (!ranked || ranked.length === 0) return;
    const top = ranked[0].mimeType.toLowerCase();
    if (top === this.appliedScreenCodec) return;
    for (const peer of this.peers.values()) {
      this.enqueue(peer, async (pr) => {
        if (this.applyScreenCodecPreferences(pr, ranked)) await this.sendOffer(pr);
      });
    }
    this.appliedScreenCodec = top;
  }

  /**
   * rankedScreenCodecs (B3): the mode's codec ladder over this browser's
   * actual send capabilities. detail/text want AV1's screen-content tools
   * -- but software AV1 encode is 3-5x VP9's CPU, so AV1 leads only when
   * the machine plausibly has headroom (>= 8 logical cores); VP9 (which
   * also carries screen tools) otherwise. motion wants sustainable 60fps:
   * VP9 > H.264 (strong hardware path) > VP8, AV1 last. rtx/red/ulpfec and
   * anything unranked keep their relative order at the tail. null when the
   * browser exposes no capability API (ladder skipped, defaults rule).
   */
  private rankedScreenCodecs(): RTCRtpCodec[] | null {
    const caps = RTCRtpSender.getCapabilities?.("video");
    if (!caps || !caps.codecs || caps.codecs.length === 0) return null;
    const av1OK = (navigator.hardwareConcurrency ?? 4) >= 8;
    const order =
      this.screenMode === "motion"
        ? CODEC_ORDER_MOTION
        : av1OK
          ? CODEC_ORDER_DETAIL_AV1
          : CODEC_ORDER_DETAIL_NO_AV1;
    const ranked: RTCRtpCodec[] = [];
    for (const family of order) {
      for (const c of caps.codecs) {
        if (c.mimeType.toLowerCase() === family) ranked.push(c);
      }
    }
    for (const c of caps.codecs) {
      if (!ranked.includes(c)) ranked.push(c);
    }
    return ranked;
  }

  /** applyScreenCodecPreferences: set the ladder on this pc's SCREEN video
   * transceivers. Best-effort (Safari/older Firefox may lack the API);
   * returns true when at least one transceiver accepted it. */
  private applyScreenCodecPreferences(
    peer: Peer,
    ranked: RTCRtpCodec[],
  ): boolean {
    const stream = this.screenStream;
    if (!stream) return false;
    const screenVideoIDs = new Set(stream.getVideoTracks().map((t) => t.id));
    let applied = false;
    for (const tr of peer.pc.getTransceivers()) {
      const id = tr.sender.track?.id;
      if (!id || !screenVideoIDs.has(id)) continue;
      if (typeof tr.setCodecPreferences !== "function") continue;
      try {
        tr.setCodecPreferences(ranked);
        applied = true;
      } catch (err) {
        console.warn("setCodecPreferences:", err);
      }
    }
    return applied;
  }

  /**
   * attachScreenTracks announces + adds the active screen tracks to one pc.
   * Returns true when tracks were added (caller renegotiates), false when
   * not sharing or already attached. The announce PRECEDES the offer on the
   * same per-peer chain, so the receiver classifies the stream before its
   * ontrack fires.
   */
  private async attachScreenTracks(peer: Peer): Promise<boolean> {
    const stream = this.screenStream;
    if (!stream) return false;
    const have = new Set(
      peer.pc
        .getSenders()
        .map((s) => s.track?.id)
        .filter((id): id is string => !!id),
    );
    const missing = stream.getTracks().filter((t) => !have.has(t.id));
    if (missing.length === 0) return false;
    await this.sendSignal(peer, "screen_add", {
      stream_id: stream.id,
    } satisfies ScreenSignal);
    for (const t of missing) peer.pc.addTrack(t, stream);
    // B3: the mode's codec ladder rides the SAME negotiation as the track.
    const ranked = this.rankedScreenCodecs();
    if (ranked && ranked.length > 0) {
      this.applyScreenCodecPreferences(peer, ranked);
      this.appliedScreenCodec = ranked[0].mimeType.toLowerCase();
    }
    this.applyBudget();
    return true;
  }

  /**
   * enableCameraMidCall (30-7b): a join that degraded to audio-only is no
   * longer terminal. Acquire a camera track now, fold it into the local
   * stream, and renegotiate it into every live pc (the 30-7a machinery
   * makes the mid-call add safe). Returns false when there's nothing to do
   * (already have a camera / not in a call) or the acquisition failed
   * (surfaced via onError).
   */
  async enableCameraMidCall(): Promise<boolean> {
    if (!this.joined || this.closed || this.hasVideo || !this.localStream) return false;
    let chain: CameraChain;
    try {
      chain = await CameraChain.open(this.devicePrefs);
    } catch (err) {
      this.o.callbacks.onError(describeMediaError("camera", err));
      return false;
    }
    if (this.closed) {
      chain.close();
      return false;
    }
    this.cameraChain = chain;
    void this.applyBackgroundBlur(this.devicePrefs.backgroundBlur); // 52-1
    const track = chain.track;
    const local = this.localStream;
    local.addTrack(track);
    this.hasVideo = true;
    this.videoEnabled = true;
    track.enabled = true;
    this.o.callbacks.onLocalStream(local);
    this.diag("camera acquired mid-call — renegotiating it in");
    for (const peer of this.peers.values()) {
      this.enqueue(peer, async (pr) => {
        pr.pc.addTrack(track, local);
        this.applyBudget();
        await this.sendOffer(pr);
      });
    }
    this.broadcastState();
    return true;
  }

  /** onScreenAdd marks a remote stream id as a screen share and flushes a
   * buffered stream that raced ahead of the announce. */
  private onScreenAdd(peer: Peer, sig: ScreenSignal): void {
    if (!sig || typeof sig.stream_id !== "string") return;
    peer.screenStreamIDs.add(sig.stream_id);
    this.diag(`peer ${peer.key} announced screen stream ${sig.stream_id}`);
    const buffered = peer.pendingStreams.get(sig.stream_id);
    if (buffered) {
      peer.pendingStreams.delete(sig.stream_id);
      this.o.callbacks.onPeerScreenStream(peer.key, peer.userID, peer.deviceID, buffered);
    }
  }

  /** onScreenRemove drops the remote screen tile. The m-line deactivation
   * arrives separately via the peer's renegotiation offer. */
  private onScreenRemove(peer: Peer, sig: ScreenSignal): void {
    if (!sig || typeof sig.stream_id !== "string") return;
    peer.screenStreamIDs.delete(sig.stream_id);
    peer.pendingStreams.delete(sig.stream_id);
    this.diag(`peer ${peer.key} removed screen stream ${sig.stream_id}`);
    this.o.callbacks.onPeerScreenGone(peer.key);
  }

  // ---- mid-call device watch (63-3) ----------------------------------------
  //
  // devicechange fires when anything is plugged, paired or pulled. Re-resolve
  // the saved mic (id, then label -- device-resolve.ts) against the new list
  // and recapture when that lands somewhere other than the device currently
  // captured: the chosen AirPods just appeared, or the mic in use vanished.
  // With no saved choice there is no target to follow -- on macOS the OS
  // default moving is invisible to us, which is exactly why picking the
  // device once by name is the supported path.
  //
  // The settle delay coalesces the burst of events one device can fire
  // (AirPods register input and output separately).

  private startDeviceWatch(): void {
    if (this.deviceWatchOff || !navigator.mediaDevices?.addEventListener) return;
    const onChange = () => {
      if (this.deviceWatchTimer !== null) window.clearTimeout(this.deviceWatchTimer);
      this.deviceWatchTimer = window.setTimeout(() => {
        this.deviceWatchTimer = null;
        void this.deviceChangeTick();
      }, DEVICE_SETTLE_MS);
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    this.deviceWatchOff = () =>
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }

  private stopDeviceWatch(): void {
    this.deviceWatchOff?.();
    this.deviceWatchOff = null;
    if (this.deviceWatchTimer !== null) window.clearTimeout(this.deviceWatchTimer);
    this.deviceWatchTimer = null;
  }

  private async deviceChangeTick(): Promise<void> {
    if (this.closed || !this.joined || !this.micChain || this.micSwitching) return;
    const prefs = this.micPrefs;
    const inputs = await listAudioInputs();
    const current = this.micChain.currentDeviceId();
    const target = resolveDeviceId(prefs.deviceId, prefs.deviceLabel, inputs);
    const currentPresent = current !== null && inputs.some((d) => d.deviceId === current);
    // Switch when the chosen device resolves somewhere new, or when the
    // device being captured is gone (then even target="" helps: recapturing
    // the default restores audio a dead mic silently stopped delivering).
    if (!((target !== "" && target !== current) || !currentPresent)) return;
    this.micSwitching = true;
    try {
      await this.micChain.recapture(prefs);
      const now = this.micChain.currentDeviceId();
      this.diag(`devicechange: mic recaptured (now=${now ?? "?"}, target=${target || "default"})`);
      // The chosen mic is back and captured: the join-time fallback notice
      // would otherwise sit on screen for the rest of the call.
      if (this.micFallbackNotice !== null && target !== "" && now === target) {
        this.o.callbacks.onErrorResolved?.(this.micFallbackNotice);
        this.micFallbackNotice = null;
      }
    } catch (err) {
      this.diag(`devicechange: mic recapture failed: ${String(err)}`);
    } finally {
      this.micSwitching = false;
    }
  }

  // ---- speaking detection (63-2) -------------------------------------------
  //
  // A few times a second, read each peer's inbound audioLevel via
  // getSynchronizationSources -- synchronous and passive, so it never
  // competes with media (the Addendum D rule getStats polling would bump
  // into). The SpeakingTracker adds the noise floor and the hold window;
  // the callback fires only when the audible set actually changes. On
  // engines without sync sources (Firefox) the sources list is empty and
  // no dot ever shows -- a quiet degrade, not an error.

  private startSpeakingPoll(): void {
    this.stopSpeakingPoll();
    this.speakTimer = window.setInterval(() => this.speakingTick(), SPEAKING_POLL_MS);
  }

  private stopSpeakingPoll(): void {
    if (this.speakTimer !== null) window.clearInterval(this.speakTimer);
    this.speakTimer = null;
    if (this.speakEmitted !== "") {
      this.speakEmitted = "";
      this.o.callbacks.onSpeaking?.([]);
    }
  }

  private speakingTick(): void {
    if (this.closed || !this.joined) return;
    const now = Date.now();
    for (const peer of this.peers.values()) {
      for (const recv of peer.pc.getReceivers()) {
        if (recv.track?.kind !== "audio") continue;
        const sources = recv.getSynchronizationSources?.() ?? [];
        for (const src of sources) {
          // A timestamp frozen since the last poll means no new audio was
          // played out (DTX/silence) -- its stale level must not count.
          const fresh = this.speakPrevTs.get(recv) !== src.timestamp;
          this.speakPrevTs.set(recv, src.timestamp);
          this.speakTracker.sample(peer.key, src.audioLevel ?? 0, fresh, now);
        }
      }
    }
    const keys = this.speakTracker.current(now);
    const joined = keys.join("\n");
    if (joined === this.speakEmitted) return;
    this.speakEmitted = joined;
    this.o.callbacks.onSpeaking?.(keys);
  }

  // ---- adaptive uplink budget (30-8, Addendum D) ---------------------------

  /** startAdaptiveTimers: the ~3 s passive fast down-guard plus the
   * scheduled replan ticks (D2, default +1/+6/+11 min from call start).
   * All reads are getStats -- never an active test mid-call. */
  private startAdaptiveTimers(): void {
    this.stopAdaptiveTimers();
    this.guardTimer = window.setInterval(
      () => void this.adaptiveTick(false),
      ADAPTIVE_GUARD_MS,
    );
    for (const s of this.adaptiveCfg.recheckSecs) {
      this.recheckTimers.push(
        window.setTimeout(() => void this.adaptiveTick(true), s * 1000),
      );
    }
  }

  private stopAdaptiveTimers(): void {
    if (this.guardTimer !== null) window.clearInterval(this.guardTimer);
    this.guardTimer = null;
    for (const t of this.recheckTimers) window.clearTimeout(t);
    this.recheckTimers = [];
  }

  /** adaptiveTick: one passive uplink read -> re-plan. replan=true marks the
   * scheduled D2 ticks where a step-UP may be taken; step-downs are allowed
   * on every tick (safety is continuous). */
  private async adaptiveTick(replan: boolean): Promise<void> {
    if (this.closed || !this.joined) return;
    const bps = await this.sumAvailableOutgoingBps();
    if (bps !== null) this.lastStatsBps = bps;
    if (replan) {
      this.diag(
        `adaptive replan tick: stats≈${bps === null ? "?" : Math.round(bps / 1000)} kbps` +
          ` probe≈${this.probeBps === null ? "?" : Math.round(this.probeBps / 1000)} kbps`,
      );
    }
    this.applyBudget(replan);
  }

  /** sumAvailableOutgoingBps: GCC's uplink estimate summed across the mesh
   * (each pc estimates ITS path; the sum approximates the shared uplink the
   * copies compete on). null until any pair reports. */
  private async sumAvailableOutgoingBps(): Promise<number | null> {
    let sum = 0;
    let seen = false;
    for (const peer of this.peers.values()) {
      try {
        const pair = extractSelectedPair(await peer.pc.getStats());
        if (pair?.availableOutgoingKbps !== undefined) {
          sum += pair.availableOutgoingKbps * 1000;
          seen = true;
        }
      } catch {
        /* pc closing -- skip */
      }
    }
    return seen ? sum : null;
  }

  /**
   * applyBudget (Addendum D): measured uplink -> headroom -> per-peer audio
   * reserve -> mesh divider (screen prioritized, camera copies drop to a
   * thumbnail while sharing) -> tier ladder with hysteresis -> per-sender
   * ceilings via setParameters (maxBitrate / scaleResolutionDownBy /
   * maxFramerate + a capture-side frameRate constraint). No renegotiation,
   * so it's cheap to run on every guard tick. The encoder still sheds
   * UNDER the ceiling per degradationPreference (motion=resolution,
   * detail/text=fps); the ladder only sets what it may never exceed.
   *
   * Best-effort: parameter support varies per browser; failures are logged
   * and ignored.
   */
  private applyBudget(replan = false): void {
    const cfg = this.adaptiveCfg;
    // Sources, best wins: probe (D1) and passive stats (D2), else the
    // conservative fallback (overshooting a thin uplink is the failure
    // mode D1 exists to prevent; the +1 min replan corrects upward).
    const measured = Math.max(this.probeBps ?? 0, this.lastStatsBps ?? 0);
    const uplink = measured > 0 ? measured : FALLBACK_UPLINK_BPS;

    const screenVideo = this.screenStream?.getVideoTracks()[0] ?? null;
    const plan = divideBudget(
      uplink,
      {
        peers: this.peers.size,
        screenActive: !!this.screenStream,
        screenAudio: (this.screenStream?.getAudioTracks().length ?? 0) > 0,
        cameraActive: this.hasVideo && this.videoEnabled,
      },
      cfg,
    );
    this.lastPlan = plan;

    let tier: Tier | null = null;
    if (this.screenStream) {
      tier = this.screenLadder.note(plan.perScreenBps, Date.now(), replan);
      if (tier !== this.appliedTier) {
        this.diag(
          `screen tier -> ${tier.name} (per-copy ≈${Math.round(plan.perScreenBps / 1000)} kbps)`,
        );
      }
      this.appliedTier = tier;
      // Game bottom rung (D3): budget too thin for motion video at all --
      // pause the track + warn once, auto-resume when the budget recovers
      // (hysteresis prevents flapping).
      if (screenVideo) {
        const shouldPause = !!tier.pause;
        if (shouldPause && screenVideo.enabled) {
          screenVideo.enabled = false;
          this.diag("game share paused: per-copy budget under the floor");
          if (!this.pauseWarned) {
            this.pauseWarned = true;
            this.o.callbacks.onError(
              "uplink too low for a game share — video paused; switch the share to screen mode or stop sharing",
            );
          }
        } else if (!shouldPause && !screenVideo.enabled) {
          screenVideo.enabled = true;
          this.pauseWarned = false;
          this.diag("game share resumed: budget recovered");
        }
        // Capture-side fps ceiling follows the rung (D3); the sender-side
        // maxFramerate below is the belt to this suspender.
        if (tier.fps !== this.appliedCaptureFps) {
          this.appliedCaptureFps = tier.fps;
          screenVideo
            .applyConstraints({ frameRate: { ideal: tier.fps, max: tier.fps } })
            .catch((err) => {
              console.warn("tier applyConstraints:", err);
            });
        }
      }
    }

    const audioBps = cfg.audioKbps * 1000;
    const screenHeight = screenVideo?.getSettings().height;
    const screenTrackIDs = new Set(this.screenStream?.getTracks().map((t) => t.id) ?? []);
    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        const kind = sender.track?.kind;
        if (kind !== "audio" && kind !== "video") continue;
        const isScreen = !!sender.track && screenTrackIDs.has(sender.track.id);
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        const enc = params.encodings[0];
        if (kind === "audio") {
          enc.maxBitrate = isScreen ? SCREEN_AUDIO_MAX_BPS : audioBps;
        } else if (isScreen && tier) {
          enc.maxBitrate = tier.maxBps;
          enc.maxFramerate = tier.fps;
          enc.scaleResolutionDownBy =
            screenHeight && screenHeight > tier.height ? screenHeight / tier.height : 1;
          // B0: pin the hint's implied preference explicitly (motion holds
          // FPS, detail/text hold resolution). Cast: lib.dom omits the
          // field in some TS versions; browsers accept it.
          (params as RTCRtpSendParameters & { degradationPreference?: string })
            .degradationPreference =
              this.screenMode === "motion" ? "maintain-framerate" : "maintain-resolution";
        } else {
          // Camera copy: the divider's cap (thumbnail while sharing). When
          // the camera is off the floor keeps a later toggle-on sane until
          // the next tick re-plans.
          enc.maxBitrate = Math.max(plan.perCameraBps, cfg.minVideoKbps * 1000);
        }
        sender.setParameters(params).catch((err) => {
          console.warn("setParameters:", err);
        });
      }
    }
  }

  // ---- misc ----------------------------------------------------------------

  private stopLocalMedia(): void {
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    // The graphs hold the real devices: stopping localStream's tracks only
    // stops their output, leaving the mic and camera (and their indicator
    // lights) live.
    void this.micChain?.close();
    this.micChain = null;
    this.cameraChain?.close();
    this.cameraChain = null;
    // The chain's close() closed the processor with it; drop the getter so the
    // drawer cannot report on a torn-down effect.
    this.blurStats = null;
    this.localStream = null;
    this.o.callbacks.onLocalStream(null);
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) t.stop();
      this.screenStream = null;
      this.o.callbacks.onLocalScreenStream(null);
    }
  }
}

function iceServerFromWire(s: ICEServerWire): RTCIceServer {
  const out: RTCIceServer = { urls: s.urls };
  if (s.username) out.username = s.username;
  if (s.credential) out.credential = s.credential;
  return out;
}

// ---- diagnostics helpers (30-4c) -------------------------------------------

/**
 * extractSelectedPair walks an RTCStatsReport for the nominated/selected
 * candidate pair and flattens the fields the debug drawer shows. Stats
 * dictionaries are only loosely typed in lib.dom, so this reads them as
 * records and tolerates absent fields across browser versions.
 */
export function extractSelectedPair(
  report: RTCStatsReport,
): VoicePeerDiag["pair"] | undefined {
  const stats = new Map<string, Record<string, unknown>>();
  report.forEach((v: unknown, k: string) => {
    stats.set(k, v as Record<string, unknown>);
  });

  // Preferred: the transport's selectedCandidatePairId. Fallback: any
  // candidate-pair with selected/nominated+succeeded.
  let pair: Record<string, unknown> | undefined;
  for (const v of stats.values()) {
    if (v.type === "transport" && typeof v.selectedCandidatePairId === "string") {
      pair = stats.get(v.selectedCandidatePairId as string);
      if (pair) break;
    }
  }
  if (!pair) {
    for (const v of stats.values()) {
      if (
        v.type === "candidate-pair" &&
        (v.selected === true || (v.nominated === true && v.state === "succeeded"))
      ) {
        pair = v;
        break;
      }
    }
  }
  if (!pair) return undefined;

  const cand = (id: unknown): Record<string, unknown> =>
    (typeof id === "string" ? stats.get(id) : undefined) ?? {};
  const local = cand(pair.localCandidateId);
  const remote = cand(pair.remoteCandidateId);
  const addr = (c: Record<string, unknown>): string => {
    const ip = (c.address ?? c.ip ?? "?") as string;
    const port = (c.port ?? "?") as number | string;
    return `${ip}:${port}`;
  };

  const out: NonNullable<VoicePeerDiag["pair"]> = {
    localType: (local.candidateType ?? "?") as string,
    localAddr: addr(local),
    remoteType: (remote.candidateType ?? "?") as string,
    remoteAddr: addr(remote),
    protocol: (local.protocol ?? pair.protocol ?? "?") as string,
  };
  if (typeof pair.currentRoundTripTime === "number") {
    out.rttMs = Math.round(pair.currentRoundTripTime * 1000);
  }
  if (typeof pair.bytesSent === "number") out.bytesSent = pair.bytesSent;
  if (typeof pair.bytesReceived === "number") out.bytesReceived = pair.bytesReceived;
  if (typeof pair.availableOutgoingBitrate === "number") {
    out.availableOutgoingKbps = Math.round(pair.availableOutgoingBitrate / 1000);
  }
  return out;
}
