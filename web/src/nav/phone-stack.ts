// 135-3: the layers of the phone as a stack of history entries. This file
// has pure functions only.
//
// Each layer on the phone is one browser history entry. The Android back
// button and the iOS back gesture then remove the top layer. The URL does
// not change. An entry stores its depth in history.state.chalkDepth. The
// list is depth 1. A chat, a thread, and a panel each add one.
//
// Four rules keep the history and the state equal:
//   - The app opens a layer: history follows state. The app pushes entries.
//   - The app closes a layer: history follows state. The app goes back.
//   - The browser goes back: state follows history. The app closes layers.
//   - The browser lands deeper than the state: the app goes back again.

/** The layers that are open, as App knows them. */
export interface PhoneLayers {
  screen: "list" | "chat";
  thread: boolean;
  panel: boolean;
}

/** One action that closes one layer. */
export type PopStep = "close-panel" | "close-thread" | "to-list";

/** stackDepth returns the number of history entries the open layers need. */
export function stackDepth(l: PhoneLayers): number {
  return 1 + (l.screen === "chat" ? 1 : 0) + (l.thread ? 1 : 0) + (l.panel ? 1 : 0);
}

/** historyDepth returns the depth stored in the state of a history entry.
 * If the entry has no valid depth, the result is 1. A valid depth is an
 * integer of 1 or more. */
export function historyDepth(entry: unknown): number {
  if (entry && typeof entry === "object") {
    const d = (entry as { chalkDepth?: unknown }).chalkDepth;
    if (typeof d === "number" && Number.isInteger(d) && d >= 1) return d;
  }
  return 1;
}

/** hasDepth reports whether the state of a history entry has a numeric
 * chalkDepth. */
export function hasDepth(entry: unknown): boolean {
  return !!entry && typeof entry === "object" && typeof (entry as { chalkDepth?: unknown }).chalkDepth === "number";
}

/** popSteps returns the actions that close layers until the stack is at
 * most toDepth deep. It closes the top layer first: the panel, then the
 * thread, then the chat. */
export function popSteps(l: PhoneLayers, toDepth: number): PopStep[] {
  const steps: PopStep[] = [];
  let depth = stackDepth(l);
  const order: [PopStep, boolean][] = [
    ["close-panel", l.panel],
    ["close-thread", l.thread],
    ["to-list", l.screen === "chat"],
  ];
  for (const [step, open] of order) {
    if (depth <= toDepth) break;
    if (!open) continue;
    steps.push(step);
    depth--;
  }
  return steps;
}

/** What the history must do to match the state: push n entries, go
 * back by a negative n, or nothing (null). */
export type Reconcile = { push: number } | { go: number } | null;

/** reconcile returns the change that makes the history depth equal the
 * state depth. If the state is deeper, it returns the number of entries to
 * push. If the state is less deep, it returns a negative number for
 * history.go. If the depths are equal, it returns null. */
export function reconcile(stateDepth: number, histDepth: number): Reconcile {
  if (stateDepth > histDepth) return { push: stateDepth - histDepth };
  if (stateDepth < histDepth) return { go: stateDepth - histDepth };
  return null;
}
