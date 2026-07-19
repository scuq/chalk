// VoiceCall (Phase 30, slice 30-4): the client-side WebRTC mesh.
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
//     (CHALK_VOICE_FORCE_RELAY -- the §7d no-P2P acceptance gate)
//   * a MINIMAL per-sender uplink budget (design Addendum D says the basic
//     caps + divider land here in 30-4; the probe/ladder arrive in 30-8)
//
// Glare-free handshake (design §4): the JOINER offers to exactly the peers in
// its voice_join_ack roster; existing peers only answer. Two corners are
// handled beyond the happy path:
//   * concurrent join: two clients join so close together that NEITHER sees
//     the other in its ack roster (each only gets the joined push). Both
//     would wait forever. Fallback: on a joined push for a peer we have no
//     pc for, arm a short timer; when it fires and the DETERMINISTIC LOWER
//     key (userID:deviceID string compare) still has no pc, IT offers.
//   * offer glare (should not occur, but a rejoining peer can race): if an
//     offer arrives while we have a local offer outstanding for that peer,
//     the LOWER key stays offerer -- the higher-key side discards its own
//     attempt and answers.
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

// ---- knobs (30-4 minimal; 30-8 replaces the constants with the probe) ------

/** Per-sender audio cap. Opus voice is comfortable well below this. */
const AUDIO_MAX_BPS = 64_000;
/** Total camera uplink budget split across peers (mesh sends N-1 copies). */
const TOTAL_VIDEO_UPLINK_BPS = 2_500_000;
/** Floor per video sender so the divider never starves a stream entirely. */
const MIN_VIDEO_BPS = 150_000;
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
  /** Non-fatal, user-visible problem (peer aborted, signal failed, ...). */
  onError(message: string): void;
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
}

function peerKey(userID: string, deviceID: string): string {
  return `${userID}:${deviceID}`;
}

/**
 * describeMediaError (30-6): turn getUserMedia's DOMException zoo into a
 * sentence a person can act on. The raw names (NotAllowedError & co.) mean
 * nothing to most users; the fix is almost always a browser permission
 * toggle or a missing/busy device.
 */
function describeMediaError(device: "microphone" | "camera", err: unknown): string {
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

/** One timestamped diagnostics event. */
export interface VoiceDiagEvent {
  t: number; // unix millis
  msg: string;
}

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

/** The full copyable diagnostics blob. */
export interface VoiceDiagnostics {
  channelID: string;
  self: string;
  forceRelay: boolean;
  iceServerURLs: string[]; // URLs only -- never the short-lived credentials
  peers: VoicePeerDiag[];
  events: VoiceDiagEvent[];
}

const DIAG_RING_MAX = 150;

export class VoiceCall {
  private readonly o: VoiceCallOptions;
  private readonly selfKey: string;
  private readonly peers = new Map<string, Peer>();
  private localStream: MediaStream | null = null;
  private iceServers: RTCIceServer[] = [];
  private forceRelay = false;
  private joined = false;
  private closed = false;
  private hasVideo = false;
  private muted = false;
  private videoEnabled = false;
  /** Verified peer identities by userID; null = looked up, unusable. */
  private readonly identities = new Map<string, { ed25519Public: Uint8Array } | null>();
  /** Concurrent-join fallback timers by peer key. */
  private readonly glareTimers = new Map<string, number>();
  /** 30-4c: bounded diagnostics event ring (see VoiceDiagEvent). */
  private readonly diagEvents: VoiceDiagEvent[] = [];

  constructor(o: VoiceCallOptions) {
    this.o = o;
    this.selfKey = peerKey(o.selfUserID, o.selfDeviceID);
  }

  get isJoined(): boolean {
    return this.joined;
  }

  get relayOnly(): boolean {
    return this.forceRelay;
  }

  // ---- diagnostics surface (30-4c) ----------------------------------------

  /** diag records one event into the bounded ring (and mirrors to debug log). */
  private diag(msg: string): void {
    this.diagEvents.push({ t: Date.now(), msg });
    if (this.diagEvents.length > DIAG_RING_MAX) {
      this.diagEvents.splice(0, this.diagEvents.length - DIAG_RING_MAX);
    }
    console.debug("[voice]", msg);
  }

  /** diagnostics returns the copyable blob: config + events + last stats. */
  async diagnostics(): Promise<VoiceDiagnostics> {
    return {
      channelID: this.o.channelID,
      self: this.selfKey,
      forceRelay: this.forceRelay,
      iceServerURLs: this.iceServers.flatMap((s) =>
        Array.isArray(s.urls) ? s.urls : [s.urls as string],
      ),
      peers: await this.collectPeerStats(),
      events: [...this.diagEvents],
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
   * 30-5h: a single join model -- always acquire the camera up front but
   * start it DISABLED (camera off by default). Because the video track
   * already exists in the published stream, the panel's cam toggle is
   * instant (track.enabled flip, no renegotiation). If the camera is denied
   * or absent we degrade to audio-only; the toggle then reports "no camera"
   * (mid-call camera add still needs renegotiation, which lands in 30-7).
   */
  async join(): Promise<void> {
    if (this.joined || this.closed) return;
    // Media first: if the mic is denied there is no point entering the room.
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      this.hasVideo = this.localStream.getVideoTracks().length > 0;
    } catch (err) {
      // Camera denied/absent but the mic may be fine: degrade to audio-only
      // rather than failing the join (design §8 permission handling). A bare
      // mic-denial still aborts.
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.hasVideo = false;
        this.o.callbacks.onError(
          describeMediaError("camera", err) + " — joined audio-only",
        );
      } catch (err2) {
        throw new Error(describeMediaError("microphone", err2));
      }
    }
    // Camera OFF by default: disable the track so no LED lights and nothing
    // is sent until the user toggles it on.
    this.videoEnabled = false;
    for (const t of this.localStream.getVideoTracks()) t.enabled = false;
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
    // 30-5h: camera starts OFF and mic starts UNMUTED, both matching the
    // server's default participant row (muted=false, video_on=false), so no
    // post-join state broadcast is needed -- the roster badges are already
    // correct. Toggling either later broadcasts via setMuted/setVideoEnabled.

    // Glare-free: the joiner (us) offers to exactly the ack roster.
    for (const p of ack.roster ?? []) {
      const key = peerKey(p.user_id, p.device_id);
      if (key === this.selfKey) continue; // server excludes us, but be safe
      this.diag(`offering to existing peer ${key}`);
      this.enqueue(this.ensurePeer(p.user_id, p.device_id), (peer) => this.sendOffer(peer));
    }
  }

  /** leave exits the room and tears everything down. Idempotent. */
  async leave(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const wasJoined = this.joined;
    this.joined = false;
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

  /** setMuted flips the mic track and broadcasts voice_state. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const t of this.localStream?.getAudioTracks() ?? []) t.enabled = !muted;
    this.broadcastState();
  }

  /**
   * setVideoEnabled flips the pre-acquired camera track on/off (instant --
   * the track is already in the published stream, 30-5h). Returns false only
   * when the join degraded to audio-only, i.e. there is no camera track
   * (adding one mid-call needs renegotiation, 30-7).
   */
  setVideoEnabled(on: boolean): boolean {
    if (!this.hasVideo) return false;
    this.videoEnabled = on;
    for (const t of this.localStream?.getVideoTracks() ?? []) t.enabled = on;
    this.broadcastState();
    return true;
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
        screen_on: false, // screen share lands in 30-7
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
              this.sendOffer(peer),
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
      // §7d: relay-only proves the no-P2P path. 'all' otherwise.
      iceTransportPolicy: this.forceRelay ? "relay" : "all",
    });
    const peer: Peer = {
      key,
      userID,
      deviceID,
      pc,
      pendingIce: [],
      hasRemoteDesc: false,
      chain: Promise.resolve(),
    };
    this.peers.set(key, peer);

    for (const track of this.localStream?.getTracks() ?? []) {
      pc.addTrack(track, this.localStream!);
    }

    pc.ontrack = (e) => {
      this.diag(`ontrack from ${key}: kind=${e.track.kind} streams=${e.streams.length}`);
      const stream = e.streams[0];
      if (stream) this.o.callbacks.onPeerStream(key, userID, deviceID, stream);
    };
    pc.onicecandidate = (e) => {
      this.diag(
        e.candidate
          ? `gathered candidate for ${key}: ${candidateTypeOf(e.candidate.candidate)}`
          : `candidate gathering done for ${key}`,
      );
      // Trickle: each candidate (and the null end-marker) rides encrypted.
      const body: IceSignal = { candidate: e.candidate ? e.candidate.toJSON() : null };
      void this.sendSignal(peer, "ice", body);
    };
    pc.onconnectionstatechange = () => {
      this.diag(`conn state ${key} = ${pc.connectionState} (ice=${pc.iceConnectionState})`);
      this.o.callbacks.onPeerState(key, pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        // v1 reconnection policy (design §9): no automatic ICE restart;
        // the peer either re-offers (rejoin) or the roster push removes it.
        this.dropPeer(key, true);
      }
    };

    this.applyBudget();
    return peer;
  }

  private dropPeer(key: string, notify: boolean): void {
    const peer = this.peers.get(key);
    if (!peer) return;
    this.peers.delete(key);
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
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

  private async sendOffer(peer: Peer): Promise<void> {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    const sdp = peer.pc.localDescription?.sdp ?? offer.sdp ?? "";
    const fpSig = await signFingerprints(
      this.o.ed25519Private,
      this.fpContextTo(peer),
      extractFingerprints(sdp),
    );
    const body: SdpSignal = { sdp, fp_sig: fpSig };
    await this.sendSignal(peer, "offer", body);
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
        default:
          // screen_add / screen_remove land in 30-7.
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
    let pr = peer;
    if (pr.pc.signalingState === "have-local-offer") {
      // Offer glare: both sides offered. Deterministic: the LOWER key stays
      // offerer. If that's us, ignore their offer (they'll answer ours by
      // the mirrored rule). If that's them, restart as a clean answerer.
      if (this.selfKey < pr.key) return;
      this.dropPeer(pr.key, false);
      pr = this.ensurePeer(peer.userID, peer.deviceID);
    } else if (pr.pc.signalingState === "stable" && pr.hasRemoteDesc) {
      // A fresh offer on an established pair = the peer rejoined (v1 has no
      // renegotiation). Start over with a clean pc.
      this.dropPeer(pr.key, false);
      pr = this.ensurePeer(peer.userID, peer.deviceID);
    }
    await pr.pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
    this.diag(`applied remote offer from ${pr.key}`);
    pr.hasRemoteDesc = true;
    await this.drainIce(pr);
    await this.sendAnswer(pr);
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
      console.warn("addIceCandidate:", err);
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

  // ---- minimal uplink budget (Addendum D, the 30-4 slice of it) ------------

  /**
   * applyBudget caps every sender: audio at AUDIO_MAX_BPS, camera video at
   * TOTAL_VIDEO_UPLINK_BPS split evenly across peers (each peer connection
   * carries its own copy of the stream in a mesh), floored at MIN_VIDEO_BPS.
   * Applied via setParameters -- no renegotiation. Best-effort: parameter
   * support varies per browser; failures are logged and ignored.
   */
  private applyBudget(): void {
    const n = Math.max(1, this.peers.size);
    const perVideo = Math.max(MIN_VIDEO_BPS, Math.floor(TOTAL_VIDEO_UPLINK_BPS / n));
    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        const kind = sender.track?.kind;
        if (kind !== "audio" && kind !== "video") continue;
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = kind === "audio" ? AUDIO_MAX_BPS : perVideo;
        sender.setParameters(params).catch((err) => {
          console.warn("setParameters:", err);
        });
      }
    }
  }

  // ---- misc ----------------------------------------------------------------

  private stopLocalMedia(): void {
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    this.localStream = null;
    this.o.callbacks.onLocalStream(null);
  }
}

function iceServerFromWire(s: ICEServerWire): RTCIceServer {
  const out: RTCIceServer = { urls: s.urls };
  if (s.username) out.username = s.username;
  if (s.credential) out.credential = s.credential;
  return out;
}

// ---- diagnostics helpers (30-4c) -------------------------------------------

/** candidateTypeOf pulls the "typ" token out of a raw candidate line. */
export function candidateTypeOf(candidate: string): string {
  const m = /\styp\s+(\S+)/.exec(candidate);
  return m ? m[1] : "?";
}

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
