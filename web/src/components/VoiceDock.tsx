// VoiceSinks (Phase 30, slices 30-5c + 30-5f): the audio of a call, mounted
// ONCE at the app level. It renders no visible box. The file keeps the name
// VoiceDock.tsx because useVoiceSession and useVoiceRoom, exported below,
// are imported from it in several places.
//
// Jobs:
//   1. AUDIO. The hidden <audio> sinks for every remote peer live HERE, not
//      in the per-channel panel -- that is the whole point of a persistent
//      call: sound keeps flowing while you read a text channel. Each sink
//      applies the peer's LOCAL prefs (A1 mute + A4-subset volume).
//   2. (30-7b) SHARED-AUDIO sinks. A peer's screen share can carry PROGRAM
//      audio (tab/system capture) as its own track. Those sinks live here
//      too, under the same per-peer local prefs.
//   3. The listeners: the Ctrl/Cmd+Shift+V jump shortcut, the pop-out
//      cleanup when the call ends, and the autoplay resume.
//
// This component draws no connection bar. On desktop the call rail
// (CallRail.tsx) shows the duration, the controls, and leave. On the phone
// PhoneCallBar shows the room, the duration, and the mute and leave
// buttons, and PhoneCallSheet is the full call view.
//
// App.tsx mounts this component as the first child of the .chalk-app
// element, at a position that does not depend on the layout. A remount
// creates new <audio> elements in the middle of a call, and a phone that
// rotates can cross the 767px breakpoint. Do not move the mount into a
// layout branch.

import { useEffect, useRef, useState } from "preact/hooks";
import { voiceSession, type VoiceSessionSnap } from "../voice/session";
import { closeAllTilePopouts } from "../voice/pip";
import { applySinkId, useAudioOutput } from "../voice/device-prefs";
import {
  boostAvailable,
  elementVolume,
  hookBoostResume,
  isBoostRunning,
  needsBoost,
  onBoostState,
  openBoost,
  type Boost,
} from "../voice/boost"; // 119-1

/** useVoiceSession: subscribe a component to the session store. */
export function useVoiceSession(): VoiceSessionSnap {
  const [snap, setSnap] = useState(voiceSession.snap());
  useEffect(() => voiceSession.subscribe(() => setSnap(voiceSession.snap())), []);
  return snap;
}

function currentRoom(): string | null {
  const s = voiceSession.snap();
  return s.phase === "idle" ? null : s.channelID;
}

/** useVoiceRoom: the room the session is in or joining, or null when idle.
 * It changes only at a join, a leave, or a move, so the app shell can read
 * it without a re-render on every speaking tick. (131-1) */
export function useVoiceRoom(): string | null {
  const [room, setRoom] = useState<string | null>(currentRoom);
  useEffect(
    () =>
      voiceSession.subscribe(() => {
        const next = currentRoom();
        setRoom((prev) => (prev === next ? prev : next));
      }),
    [],
  );
  return room;
}

interface Props {
  onJumpToChannel: (channelID: string) => void;
}

export function VoiceSinks({ onJumpToChannel }: Props) {
  const snap = useVoiceSession();

  const jumpBack = () => {
    if (snap.channelID) onJumpToChannel(snap.channelID);
  };

  // 45-5: a popped-out tile is a window of its own, so it outlives the call
  // panel that opened it -- browse to a text channel and that panel unmounts.
  // VoiceSinks is mounted for as long as the app is, so closing the pop-outs
  // when the call ends belongs here rather than there.
  useEffect(() => {
    if (snap.phase === "idle") closeAllTilePopouts();
  }, [snap.phase]);

  // 30-5f jump shortcut: Ctrl/Cmd+Shift+V snaps to the connected room from
  // anywhere. Registered only while connected; ignores keystrokes aimed at
  // text inputs so it never fights typing.
  useEffect(() => {
    if (snap.phase !== "in-call" || !snap.channelID) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      if (e.key !== "V" && e.key !== "v") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      e.preventDefault();
      jumpBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.phase, snap.channelID]);

  // 30-5i: when playback is autoplay-blocked, the FIRST user interaction
  // anywhere resumes every audio element and clears the nudge. One-shot.
  useEffect(() => {
    if (!snap.audioBlocked) return;
    const resume = () => {
      document.querySelectorAll("audio").forEach((el) => {
        const p = (el as HTMLAudioElement).play?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
      });
      voiceSession.clearAudioBlocked();
    };
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
    return () => {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
    };
  }, [snap.audioBlocked]);

  return (
    <>
      {/* Job 1: app-level audio, always rendered while tiles exist. */}
      {Object.values(snap.tiles).map((t) => {
        const pref = snap.peerAudio[t.userID];
        return (
          <AudioSink
            key={t.key}
            stream={t.stream}
            muted={snap.deafened || !!pref?.muted}
            volume={typeof pref?.volume === "number" ? pref.volume : 1}
          />
        );
      })}
      {/* Job 2 (30-7b): shared PROGRAM audio (tab/system capture riding a
          screen share). 96-3: on its OWN local mute and volume, not the
          person's. 30-7b tied the two together on the reading that muting
          someone means muting their game as well; in use it is the reverse
          that people reach for -- turn the game down to hear the person over
          it -- and one slider could not express it. Deafen still takes
          everything: that control means silence. */}
      {Object.values(snap.tiles)
        .filter((t) => t.screenStream && t.screenStream.getAudioTracks().length > 0)
        .map((t) => {
          const pref = snap.peerAudio[t.userID];
          return (
            <AudioSink
              key={t.key + ":screen"}
              stream={t.screenStream!}
              muted={snap.deafened || !!pref?.screenMuted}
              volume={typeof pref?.screenVolume === "number" ? pref.screenVolume : 1}
            />
          );
        })}

    </>
  );
}

function AudioSink({
  stream,
  muted,
  volume,
}: {
  stream: MediaStream;
  muted: boolean;
  volume: number;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  // 44-9: playback follows the chosen output device. Per element rather than
  // once globally, because setSinkId IS a property of the element -- and the
  // sinks come and go with the peers.
  const outputId = useAudioOutput();

  // 119-1: over 100% the element cannot carry the level, so the stream goes
  // through a gain graph (voice/boost.ts) and the element plays the graph's
  // output at 1. The graph is only trusted while its context is running: a
  // reload with a stored boost has had no gesture yet, and routing through
  // a suspended context is silence. Until it runs, the raw stream plays at
  // 100% and the next pointer or key anywhere resumes it.
  const boosted = needsBoost(volume);
  const [ctxRunning, setCtxRunning] = useState(isBoostRunning());
  useEffect(() => {
    if (!boosted || !boostAvailable()) return;
    setCtxRunning(isBoostRunning());
    if (!isBoostRunning()) hookBoostResume();
    return onBoostState(() => setCtxRunning(isBoostRunning()));
  }, [boosted]);
  const useGraph = boosted && ctxRunning;
  const boostRef = useRef<Boost | null>(null);
  const rawRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let play: MediaStream = stream;
    if (useGraph) {
      if (boostRef.current?.raw !== stream) {
        boostRef.current?.release();
        boostRef.current = openBoost(stream, volume);
      }
      if (boostRef.current) play = boostRef.current.stream;
    } else if (boostRef.current) {
      boostRef.current.release();
      boostRef.current = null;
    }
    // Chromium only feeds a remote WebRTC track into Web Audio while some
    // media element is also playing it, so the raw stream stays attached to
    // a muted element for as long as the graph is in use.
    if (rawRef.current) {
      const keep = useGraph && play !== stream ? stream : null;
      if (rawRef.current.srcObject !== keep) rawRef.current.srcObject = keep;
    }
    if (el.srcObject !== play) {
      el.srcObject = play;
      // 30-5i: after an auto-rejoin there's been no user gesture, so the
      // browser's autoplay policy may reject playback. Detect it and flag
      // the nudge in the call rail or the phone call bar; a global click
      // (below) resumes.
      const p = el.play?.();
      if (p && typeof p.catch === "function") {
        p.catch(() => voiceSession.notifyAudioBlocked());
      }
    }
    // volume is applied by the effect below; this one only decides routing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, useGraph]);
  useEffect(() => () => boostRef.current?.release(), []);

  // Prefs via properties, not attributes: the muted ATTRIBUTE only sets the
  // default, and volume has no attribute at all.
  useEffect(() => {
    if (ref.current) {
      ref.current.muted = muted;
      // While the graph carries the level the element sits at 1.
      ref.current.volume = useGraph ? 1 : elementVolume(volume);
    }
    boostRef.current?.setGain(volume);
  }, [muted, volume, useGraph]);
  // Re-applied on every new stream too: a sink set before srcObject exists is
  // not carried across in every engine.
  useEffect(() => {
    void applySinkId(ref.current, outputId);
  }, [outputId, stream]);
  return (
    <>
      <audio ref={ref} autoPlay style={{ display: "none" }} />
      <audio ref={rawRef} autoPlay muted style={{ display: "none" }} />
    </>
  );
}
