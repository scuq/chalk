// VoiceDock (Phase 30, slices 30-5c + 30-5f): the Discord bottom-left
// connection panel, mounted ONCE at the app level (bottom of the sidebar).
//
// Jobs:
//   1. AUDIO. The hidden <audio> sinks for every remote peer live HERE, not
//      in the per-channel panel -- that is the whole point of a persistent
//      call: sound keeps flowing while you read a text channel. Each sink
//      applies the peer's LOCAL prefs (A1 mute + A4-subset volume).
//   2. THE BAR. While connected, one row: the room name (a click jumps back
//      to the room), the live duration, the live dot, and disconnect. While
//      joining, the duration slot shows "joining…". Since 131-2 the dock has
//      no video preview and no status row. The call rail (CallRail.tsx)
//      shows who is in the call.
//   2b. (30-7b) SHARED-AUDIO sinks + the sharing row. A peer's screen share
//      can carry PROGRAM audio (tab/system capture) as its own track --
//      those sinks live here too, under the same per-peer local prefs. And
//      while YOU share, the dock says so everywhere (with a stop button):
//      forgetting a live screen share is the classic embarrassment.
//
// 126-2: job 2, the bar, has a phone sibling, ZuckerCallBar. Zuckermode
// hides this dock inside the sidebar drawer, so the phone's home screen
// reads the same session snapshot (useVoiceSession, below) and shows its
// own bar and leave button instead.

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
import { fmtDuration } from "../voice/duration"; // 126-2: shared with ZuckerCallBar
import { ChannelGlyph } from "./Sidebar";

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

export function VoiceDock({ onJumpToChannel }: Props) {
  const snap = useVoiceSession();
  const [, setTick] = useState(0);

  // Duration ticker while connected.
  useEffect(() => {
    if (snap.phase !== "in-call") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [snap.phase]);

  const jumpBack = () => {
    if (snap.channelID) onJumpToChannel(snap.channelID);
  };

  // 45-5: a popped-out tile is a window of its own, so it outlives the call
  // panel that opened it -- browse to a text channel and that panel unmounts.
  // The dock is mounted for as long as the app is, so closing the pop-outs
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
      {/* Job 2b (30-7b): shared PROGRAM audio (tab/system capture riding a
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

      {/* Job 2: the connection bar. One row since 131-2: the room, how
          long, the live dot, and leave. The rail shows who is there. */}
      {snap.phase !== "idle" && (
        <div class="chalk-voice-dock" data-testid="voice-dock">
          <div class="chalk-voice-dock-row">
            <button
              class="chalk-voice-dock-channel"
              type="button"
              onClick={jumpBack}
              title="jump to the voice room (Ctrl+Shift+V)"
              data-testid="voice-dock-channel"
            >
              <span class="chalk-chglyph chalk-chglyph--voice chalk-chglyph--inline">
                <ChannelGlyph type="voice" />
              </span>
              <span class="chalk-voice-dock-channame">{snap.channelName || "voice"}</span>
            </button>
            <span class="chalk-voice-dock-spacer" />
            {snap.phase !== "in-call" ? (
              <span class="chalk-voice-dock-status" data-connected="false">
                joining…
              </span>
            ) : (
              snap.joinedAt !== null && (
                <span class="chalk-voice-dock-duration" data-testid="voice-dock-duration">
                  {fmtDuration(Date.now() - snap.joinedAt)}
                </span>
              )
            )}
            {/* 41-5: the gate is open and we are audible. Absent while muted --
                a live dot next to a mute button reads as a contradiction. */}
            {!snap.muted && snap.micOpen && (
              <span
                class="chalk-voice-live"
                title="your microphone is transmitting"
                data-testid="voice-dock-live"
              />
            )}
            {/* 44-2: mute and deafen used to live here too. They are global
                now, and the cluster that owns them sits directly below this
                dock in the same column -- two identical mute buttons a
                centimetre apart is worse than one. The dock keeps what is
                genuinely about THIS call: where it is, how long, and leaving. */}
            <button
              class="chalk-btn chalk-voice-ctl chalk-voice-ctl--leave"
              type="button"
              onClick={() => void voiceSession.leave()}
              title="disconnect from voice"
              aria-label="disconnect from voice"
              data-testid="voice-dock-leave"
            >
              <CtlLabel wide="leave" mini="l" />
            </button>
          </div>
          {snap.sharing && (
            <div class="chalk-voice-dock-row" data-testid="voice-dock-sharing">
              <span class="chalk-voice-dock-status" data-connected="true">
                sharing screen · {snap.shareMode}
              </span>
              <span class="chalk-voice-dock-spacer" />
              <button
                class="chalk-btn chalk-voice-ctl chalk-voice-ctl--off"
                type="button"
                onClick={() => void voiceSession.toggleScreenShare()}
                title="stop sharing your screen"
                data-testid="voice-dock-stopshare"
              >
                stop
              </button>
            </div>
          )}
          {snap.audioBlocked && (
            <div class="chalk-voice-dock-row chalk-voice-audionudge" data-testid="voice-audio-nudge">
              🔇 click anywhere to enable audio
            </div>
          )}
        </div>
      )}
    </>
  );
}

// CtlLabel: both spellings of a dock control's label, with CSS picking one.
// A narrow sidebar can't fit "unmute · undeafen · leave" -- the buttons used
// to spill out of the column and over the message list -- so a container
// query on the dock collapses them to single letters. The letter is fixed per
// control (mic / deafen / leave) rather than tracking the current action:
// muted + deafened would otherwise render "u u l".
function CtlLabel({ wide, mini }: { wide: string; mini: string }) {
  return (
    <>
      <span class="chalk-voice-ctl-wide">{wide}</span>
      <span class="chalk-voice-ctl-mini">{mini}</span>
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
      // the dock nudge; a global click (below) resumes.
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
