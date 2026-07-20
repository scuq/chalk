// chalk-web -- voice adaptive quality (30-8, design Addendum D).
//
// WebRTC's own congestion control (GCC) already estimates each path and
// auto-downscales the encoder to fit it, steered by the degradationPreference
// pinned in call.ts (motion sheds resolution, detail/text shed fps). What the
// browser CANNOT know is that a mesh uploads N-1 copies that all compete on
// one uplink (D0). This module adds exactly that missing piece:
//
//   * a MESH BUDGET DIVIDER (D3): measured uplink -> headroom -> per-peer
//     audio reserve -> video budget -> per-copy caps, with the SCREEN share
//     prioritized (camera copies drop to a thumbnail cap while sharing).
//   * a TIER LADDER with HYSTERESIS (D3): the per-copy budget picks a
//     resolution/fps/bitrate ceiling per share mode. Down-steps are fast
//     (sustained ~3 s under the floor), up-steps are slow (held ~30 s AND
//     only at deliberate replan points), one tier per step.
//   * the PRE-STREAM PROBE (D1): a timed HTTP upload to POST /api/netprobe
//     picks the STARTING tier, skipping GCC's slow 15%->100% ramp. Because
//     chalk media is coturn-relayed and coturn sits with chalkd, uplink to
//     the server is a sound proxy for the relay uplink media actually uses.
//   * in-call re-checks are PASSIVE (D2): getStats availableOutgoingBitrate
//     reads on the configured schedule -- never an active test mid-call,
//     which would compete with the media it measures.
//
// Everything here is DOM-free pure logic (probeUplink uses fetch, available
// under node too) so `node test.mjs` can pin the math down; call.ts owns the
// timers, getStats reads and sender.setParameters application.

import type { VoiceAdaptiveWire } from "../proto";
import type { ScreenShareMode } from "./call";

// ---- settings (server-provided; these are the fallback defaults) -----------

/** AdaptiveSettings mirror the CHALK_VOICE_* adaptive knobs (D5), delivered
 * per-join on voice_join_ack.adaptive. Defaults match the server's. */
export interface AdaptiveSettings {
  probeEnabled: boolean;
  probeBytes: number;
  /** Replan tick offsets from call start, seconds (D2; default +1/+6/+11m). */
  recheckSecs: number[];
  /** Fraction of the measured uplink the planner may spend (default 0.85). */
  uplinkHeadroom: number;
  /** Per-peer voice reserve, kbps (default 64). */
  audioKbps: number;
  /** Per-copy floor before video is considered unsustainable (default 300). */
  minVideoKbps: number;
}

export const DEFAULT_ADAPTIVE: AdaptiveSettings = {
  probeEnabled: true,
  probeBytes: 3_000_000,
  recheckSecs: [60, 360, 660],
  uplinkHeadroom: 0.85,
  audioKbps: 64,
  minVideoKbps: 300,
};

/** parseAdaptiveWire overlays the join-ack block onto the defaults. Absent /
 * malformed fields keep the default -- a stale server stays safe. */
export function parseAdaptiveWire(w: VoiceAdaptiveWire | undefined): AdaptiveSettings {
  const d = { ...DEFAULT_ADAPTIVE, recheckSecs: [...DEFAULT_ADAPTIVE.recheckSecs] };
  if (!w) return d;
  if (typeof w.probe_enabled === "boolean") d.probeEnabled = w.probe_enabled;
  if (typeof w.probe_bytes === "number" && w.probe_bytes > 0) d.probeBytes = w.probe_bytes;
  if (Array.isArray(w.recheck_secs)) {
    const secs = w.recheck_secs.filter((n) => typeof n === "number" && n > 0);
    if (secs.length > 0) d.recheckSecs = secs;
  }
  if (
    typeof w.uplink_headroom === "number" &&
    w.uplink_headroom > 0 &&
    w.uplink_headroom <= 1
  ) {
    d.uplinkHeadroom = w.uplink_headroom;
  }
  if (typeof w.audio_kbps === "number" && w.audio_kbps > 0) d.audioKbps = w.audio_kbps;
  if (typeof w.min_video_kbps === "number" && w.min_video_kbps > 0) {
    d.minVideoKbps = w.min_video_kbps;
  }
  return d;
}

// ---- tier ladders (D3) ------------------------------------------------------

/** One rung: the per-copy budget threshold that unlocks it, and the ceiling
 * (bitrate / height / fps) applied via sender.setParameters. The encoder
 * still sheds UNDER the ceiling per degradationPreference; the ladder only
 * sets what it may never exceed. */
export interface Tier {
  name: string;
  /** Per-copy budget (bits/s) required to sit on this rung. */
  minBps: number;
  maxBps: number;
  height: number;
  fps: number;
  /** Game-mode bottom rung: budget too thin for motion video at all --
   * pause the share (track disabled) and warn, rather than send mush. */
  pause?: boolean;
}

/** GAME (motion): holds FPS, sheds resolution; needs real bitrate. */
export const GAME_LADDER: Tier[] = [
  { name: "1080p60", minBps: 6_000_000, maxBps: 6_000_000, height: 1080, fps: 60 },
  { name: "1080p60", minBps: 3_000_000, maxBps: 4_000_000, height: 1080, fps: 60 },
  { name: "720p60", minBps: 1_500_000, maxBps: 2_500_000, height: 720, fps: 60 },
  { name: "540p60", minBps: 800_000, maxBps: 1_200_000, height: 540, fps: 60 },
  { name: "360p30", minBps: 400_000, maxBps: 600_000, height: 360, fps: 30 },
  { name: "paused", minBps: 0, maxBps: 300_000, height: 360, fps: 15, pause: true },
];

/** SCREEN (detail/text): holds resolution, sheds FPS; screen content
 * compresses cheaply so even thin budgets stay readable -- never pauses. */
export const SCREEN_LADDER: Tier[] = [
  { name: "1080p30", minBps: 6_000_000, maxBps: 2_500_000, height: 1080, fps: 30 },
  { name: "1080p30", minBps: 3_000_000, maxBps: 1_500_000, height: 1080, fps: 30 },
  { name: "1080p15", minBps: 1_500_000, maxBps: 1_000_000, height: 1080, fps: 15 },
  { name: "900p10", minBps: 800_000, maxBps: 600_000, height: 900, fps: 10 },
  { name: "720p8", minBps: 400_000, maxBps: 400_000, height: 720, fps: 8 },
  { name: "720p5", minBps: 0, maxBps: 300_000, height: 720, fps: 5 },
];

export function ladderFor(mode: ScreenShareMode): Tier[] {
  return mode === "motion" ? GAME_LADDER : SCREEN_LADDER;
}

/** pickTier: the best rung whose threshold the budget clears. Index into the
 * ladder (0 = best); always resolves (the bottom rung's minBps is 0). */
export function pickTier(ladder: Tier[], perCopyBps: number): number {
  for (let i = 0; i < ladder.length; i++) {
    if (perCopyBps >= ladder[i].minBps) return i;
  }
  return ladder.length - 1;
}

// ---- the mesh budget divider (D3) ------------------------------------------

/** Camera copies take a small thumbnail cap off the top while a screen share
 * is up -- the share is what people are watching (D3/D4, ~150-300k each). */
export const CAMERA_THUMB_BPS = 250_000;

/** Starting uplink assumption when neither probe nor stats have reported yet.
 * Deliberately conservative: overshooting a thin uplink on join is the
 * failure D1 exists to prevent; the +1 min replan corrects upward quickly. */
export const FALLBACK_UPLINK_BPS = 6_000_000;

export interface BudgetInput {
  /** Peer connections currently in the mesh (copies per outbound stream). */
  peers: number;
  /** Whether a screen share is being sent. */
  screenActive: boolean;
  /** Whether shared program audio is being sent alongside the screen. */
  screenAudio: boolean;
  /** Whether the camera is on (sending real video, not a disabled track). */
  cameraActive: boolean;
}

export interface BudgetPlan {
  uplinkBps: number;
  videoBudgetBps: number;
  /** Per-copy camera cap (0 when no camera). */
  perCameraBps: number;
  /** Per-copy screen budget fed to the ladder (0 when not sharing). */
  perScreenBps: number;
}

/** Shared program audio cap, mirrored from call.ts's SCREEN_AUDIO_MAX_BPS. */
const SCREEN_AUDIO_BPS = 128_000;

/** divideBudget: measured uplink -> per-copy caps. Screen gets priority:
 * cameras are clamped to a thumbnail first, the screen keeps the rest. */
export function divideBudget(
  uplinkBps: number,
  input: BudgetInput,
  cfg: AdaptiveSettings,
): BudgetPlan {
  const peers = Math.max(1, input.peers);
  const usable = uplinkBps * cfg.uplinkHeadroom;
  let audioReserve = peers * cfg.audioKbps * 1000;
  if (input.screenActive && input.screenAudio) {
    audioReserve += peers * SCREEN_AUDIO_BPS;
  }
  const videoBudget = Math.max(0, usable - audioReserve);
  const minVideo = cfg.minVideoKbps * 1000;

  let perCamera = 0;
  let perScreen = 0;
  if (input.screenActive) {
    if (input.cameraActive) {
      // Thumbnail cap, but never more than an equal split would give.
      perCamera = Math.min(CAMERA_THUMB_BPS, Math.floor(videoBudget / (2 * peers)));
      perCamera = Math.max(perCamera, 0);
    }
    perScreen = Math.max(minVideo, Math.floor(videoBudget / peers - perCamera));
  } else if (input.cameraActive) {
    perCamera = Math.max(minVideo, Math.floor(videoBudget / peers));
  }
  return { uplinkBps, videoBudgetBps: videoBudget, perCameraBps: perCamera, perScreenBps: perScreen };
}

// ---- hysteresis (D3) --------------------------------------------------------

/** Down-step: budget must sit under the current rung's floor this long. */
export const DOWN_HOLD_MS = 3_000;
/** Up-step: the next rung's threshold must hold this long, and the step is
 * only taken at a deliberate replan point (the D2 schedule). */
export const UP_HOLD_MS = 30_000;

/**
 * HysteresisLadder tracks the screen share's rung. call.ts feeds it the
 * per-copy budget from every passive read (the ~3 s fast guard) and marks
 * the scheduled ticks as replan points. One rung per step, never a jump.
 */
export class HysteresisLadder {
  private ladder: Tier[];
  private idx = -1; // -1: no pick yet -- first note() seeds directly
  private belowSince: number | null = null;
  private upSince: number | null = null;

  constructor(ladder: Tier[]) {
    this.ladder = ladder;
  }

  /** switchLadder (mode flip): re-seed from the next note(). */
  switchLadder(ladder: Tier[]): void {
    this.ladder = ladder;
    this.idx = -1;
    this.belowSince = null;
    this.upSince = null;
  }

  reset(): void {
    this.switchLadder(this.ladder);
  }

  get tier(): Tier | null {
    return this.idx >= 0 ? this.ladder[this.idx] : null;
  }

  /**
   * note ingests one budget observation. Returns the tier to apply (never
   * null once seeded) -- the caller re-applies sender parameters only when
   * the rung actually changed.
   *
   *   - first observation seeds the rung directly (the D1 starting pick);
   *   - below the current rung's floor for > DOWN_HOLD_MS -> one rung down
   *     (allowed on ANY observation -- safety is continuous, D2);
   *   - above the next rung's threshold for > UP_HOLD_MS AND replan=true
   *     -> one rung up (deliberate re-planning only).
   */
  note(perCopyBps: number, nowMs: number, replan: boolean): Tier {
    if (this.idx < 0) {
      this.idx = pickTier(this.ladder, perCopyBps);
      return this.ladder[this.idx];
    }
    // Fast down-guard.
    if (perCopyBps < this.ladder[this.idx].minBps) {
      if (this.belowSince === null) this.belowSince = nowMs;
      if (nowMs - this.belowSince >= DOWN_HOLD_MS && this.idx < this.ladder.length - 1) {
        this.idx++;
        this.belowSince = null;
        this.upSince = null;
      }
      return this.ladder[this.idx];
    }
    this.belowSince = null;
    // Slow up-step, one rung, replan points only.
    if (this.idx > 0 && perCopyBps >= this.ladder[this.idx - 1].minBps) {
      if (this.upSince === null) this.upSince = nowMs;
      if (replan && nowMs - this.upSince >= UP_HOLD_MS) {
        this.idx--;
        this.upSince = null;
      }
    } else {
      this.upSince = null;
    }
    return this.ladder[this.idx];
  }
}

// ---- the pre-stream probe (D1) ----------------------------------------------

/**
 * probeUplink times an upload of `bytes` random-ish bytes to /api/netprobe
 * and returns the SERVER-measured bits/s (the server clock excludes our
 * request-setup overhead), or null on any failure -- the planner then falls
 * back to FALLBACK_UPLINK_BPS refined by passive stats. Run ONLY while no
 * media flows (active tests mid-call are forbidden, D2).
 */
export async function probeUplink(bytes: number): Promise<number | null> {
  try {
    // Incompressible payload so transparent gzip can't flatter the number.
    const body = new Uint8Array(bytes);
    crypto.getRandomValues(body.subarray(0, Math.min(bytes, 65_536)));
    for (let off = 65_536; off < bytes; off += 65_536) {
      body.copyWithin(off, 0, Math.min(65_536, bytes - off));
    }
    const resp = await fetch("/api/netprobe", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/octet-stream" },
      credentials: "same-origin",
    });
    if (!resp.ok) return null;
    const out = (await resp.json()) as { bps?: number };
    return typeof out.bps === "number" && out.bps > 0 ? out.bps : null;
  } catch {
    return null;
  }
}
