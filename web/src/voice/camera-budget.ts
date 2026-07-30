// chalk-web -- keeping a camera effect inside its frame budget (52-3).
//
// THE PROBLEM THIS SOLVES, precisely. CameraChain drops a tick whose predecessor
// is still rendering. As a safety valve that is right; as a steady state it is
// the wrong trade. A machine where segmentation takes 50 ms cannot publish 30
// fps, and dropping every other frame means everyone watching sees the picture
// stutter -- to hide a room they were never looking at.
//
// So: segment LESS OFTEN rather than draw less often. A segmentation mask is
// temporally coherent (people do not teleport), and reusing one for a frame or
// two is nearly invisible on ordinary motion, while compositing keeps running at
// full rate. The failure mode goes from "their video is choppy" to "the edge
// around them lags slightly", which is the better thing to be wrong about.
//
// The ladder follows 30-8's rule -- fast down, slow up. Backing off happens on
// the first sample that says we are in trouble; recovering requires a sustained
// run of comfortable ones, because a cadence that oscillates is worse than one
// that settles a rung low.

/** Fraction of the frame budget above which we are in trouble. */
const BACK_OFF_AT = 0.8;

/** Fraction below which the machine is comfortably keeping up. */
const RECOVER_AT = 0.4;

/** Never segment less often than every Nth frame -- past this, the mask lags
 *  visibly and the effect is not worth its cost. */
export const MAX_EVERY = 3;

/** Consecutive comfortable frames before stepping back up. ~1s at 30fps. */
export const RECOVER_FRAMES = 30;

/** Consecutive over-budget frames AT THE FLOOR before giving up entirely.
 *  ~2s at 30fps: long enough to ride out a transient (another tab compiling,
 *  a screen share starting), short enough that nobody sits through it. */
export const GIVE_UP_FRAMES = 60;

/** Smoothing for the cost estimate. Low enough that one slow frame -- a GC
 *  pause, a tab switch -- cannot move the cadence on its own. */
const EMA_ALPHA = 0.1;

/** ema folds a new sample into a running average. */
export function ema(prev: number | null, sample: number, alpha = EMA_ALPHA): number {
  if (prev === null || !Number.isFinite(prev)) return sample;
  return prev + alpha * (sample - prev);
}

/** How often the expensive step runs, and the streaks behind that decision. */
export interface Cadence {
  /** Segment every Nth frame. 1 = every frame. */
  every: number;
  good: number;
  bad: number;
}

export const INITIAL_CADENCE: Cadence = { every: 1, good: 0, bad: 0 };

export interface CadenceDecision extends Cadence {
  /** The effect cannot hold even the slowest cadence; the caller should stop. */
  giveUp: boolean;
}

/**
 * planCadence folds one frame's measured cost into the cadence.
 *
 * costMs is the SMOOTHED cost of a full render, not of the segmentation alone:
 * what matters is whether the whole draw fits in the time between ticks, and
 * the compositing is not free either.
 *
 * A budget that is zero or nonsense leaves the cadence alone rather than
 * dividing by it -- a chain that cannot say how long a frame has is not
 * evidence about this machine's speed.
 */
export function planCadence(prev: Cadence, costMs: number, budgetMs: number): CadenceDecision {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || !Number.isFinite(costMs)) {
    return { ...prev, giveUp: false };
  }
  if (costMs > budgetMs * BACK_OFF_AT) {
    if (prev.every < MAX_EVERY) {
      // Step down and give the new cadence a clean slate: its cost has not
      // been measured yet, so counting the old rung's misses against it would
      // walk straight to the floor.
      return { every: prev.every + 1, good: 0, bad: 0, giveUp: false };
    }
    const bad = prev.bad + 1;
    return { every: prev.every, good: 0, bad, giveUp: bad >= GIVE_UP_FRAMES };
  }
  if (costMs < budgetMs * RECOVER_AT) {
    const good = prev.good + 1;
    if (prev.every > 1 && good >= RECOVER_FRAMES) {
      return { every: prev.every - 1, good: 0, bad: 0, giveUp: false };
    }
    return { every: prev.every, good, bad: 0, giveUp: false };
  }
  // The middle band: fitting, but not comfortably. Hold the cadence, and do
  // not accumulate credit towards stepping up -- that is what stops a machine
  // sitting right on the line from oscillating.
  return { every: prev.every, good: 0, bad: 0, giveUp: false };
}

/**
 * shouldRunExpensiveStep answers "is this the frame that segments?"
 *
 * Frame 0 always does: the first composite has no previous mask to reuse, and
 * skipping it would publish the person cut out of nothing.
 */
export function shouldRunExpensiveStep(frame: number, every: number): boolean {
  if (every <= 1) return true;
  return frame % every === 0;
}
