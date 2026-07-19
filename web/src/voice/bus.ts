// voiceBus (30-4): a minimal fan-out point between App.handleFrame (which
// owns the single WS onFrame dispatch) and whatever voice UI is mounted.
//
// Why not route through the reducer? Signal frames (offer/answer/ICE) are
// imperative events for the live RTCPeerConnection mesh, not state -- putting
// SDP blobs in app state would be wrong (and would re-render on every ICE
// candidate). Roster deltas DO go through the reducer (sidebar occupancy);
// this bus additionally hands the raw frames to the active VoiceCall so it
// can tear down peers on "left" and process signals.
//
// Deliberately tiny: subscribe/emit, synchronous, no history. If no panel is
// mounted, frames fall on the floor -- correct: signaling for a room we're
// not in is meaningless (the server only relays signals to participants, so
// in practice this only drops stale frames during unmount races).

import type { Frame } from "../proto";

type Listener = (f: Frame) => void;

const listeners = new Set<Listener>();

export const voiceBus = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(f: Frame): void {
    for (const fn of listeners) {
      try {
        fn(f);
      } catch (err) {
        console.error("voiceBus listener threw:", err);
      }
    }
  },
};
