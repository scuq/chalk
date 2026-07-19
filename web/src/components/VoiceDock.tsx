// VoiceDock (Phase 30, slice 30-5c): the Discord bottom-left connection
// panel, mounted ONCE at the app level (bottom of the sidebar).
//
// Two jobs:
//   1. AUDIO. The hidden <audio> sinks for every remote peer live HERE, not
//      in the per-channel panel -- that is the whole point of a persistent
//      call: sound keeps flowing while you read a text channel. (The panel
//      renders video only; rendering audio in both places would double it.)
//   2. THE BAR. While connected: "voice connected" + room name (click jumps
//      back to the room), live duration, mute toggle, disconnect. Hidden
//      when idle -- the dock takes no space unless there is a call.

import { useEffect, useRef, useState } from "preact/hooks";
import { voiceSession, type VoiceSessionSnap } from "../voice/session";
import { ChannelGlyph } from "./Sidebar";

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** useVoiceSession: subscribe a component to the session store. */
export function useVoiceSession(): VoiceSessionSnap {
  const [snap, setSnap] = useState(voiceSession.snap());
  useEffect(() => voiceSession.subscribe(() => setSnap(voiceSession.snap())), []);
  return snap;
}

export function VoiceDock({ onJumpToChannel }: { onJumpToChannel: (channelID: string) => void }) {
  const snap = useVoiceSession();
  const [, setTick] = useState(0);

  // Duration ticker while connected.
  useEffect(() => {
    if (snap.phase !== "in-call") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [snap.phase]);

  return (
    <>
      {/* Job 1: app-level audio, always rendered while tiles exist. Each
          sink applies the peer's LOCAL prefs (A1 mute + A4-subset volume) --
          receive-side only, invisible to everyone else. */}
      {Object.values(snap.tiles).map((t) => {
        const pref = snap.peerAudio[t.userID];
        return (
          <AudioSink
            key={t.key}
            stream={t.stream}
            muted={!!pref?.muted}
            volume={typeof pref?.volume === "number" ? pref.volume : 1}
          />
        );
      })}

      {/* Job 2: the connection bar. */}
      {snap.phase !== "idle" && (
        <div class="chalk-voice-dock" data-testid="voice-dock">
          <div class="chalk-voice-dock-row">
            <span
              class="chalk-voice-dock-status"
              data-connected={snap.phase === "in-call" ? "true" : "false"}
            >
              {snap.phase === "in-call" ? "voice connected" : "joining…"}
            </span>
            {snap.phase === "in-call" && snap.joinedAt !== null && (
              <span class="chalk-voice-dock-duration" data-testid="voice-dock-duration">
                {fmtDuration(Date.now() - snap.joinedAt)}
              </span>
            )}
          </div>
          <div class="chalk-voice-dock-row">
            <button
              class="chalk-voice-dock-channel"
              type="button"
              onClick={() => snap.channelID && onJumpToChannel(snap.channelID)}
              title="jump to the voice room"
              data-testid="voice-dock-channel"
            >
              <span class="chalk-chglyph chalk-chglyph--voice">
                <ChannelGlyph type="voice" />
              </span>
              {snap.channelName || "voice"}
            </button>
            <span class="chalk-voice-dock-spacer" />
            <button
              class={"chalk-btn chalk-voice-ctl" + (snap.muted ? " chalk-voice-ctl--off" : "")}
              type="button"
              onClick={() => voiceSession.toggleMute()}
              title={snap.muted ? "unmute microphone" : "mute microphone"}
              data-testid="voice-dock-mute"
            >
              {snap.muted ? "unmute" : "mute"}
            </button>
            <button
              class="chalk-btn chalk-voice-ctl chalk-voice-ctl--leave"
              type="button"
              onClick={() => void voiceSession.leave()}
              title="disconnect from voice"
              data-testid="voice-dock-leave"
            >
              leave
            </button>
          </div>
        </div>
      )}
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
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  // Prefs via properties, not attributes: the muted ATTRIBUTE only sets the
  // default, and volume has no attribute at all.
  useEffect(() => {
    if (ref.current) {
      ref.current.muted = muted;
      ref.current.volume = Math.min(1, Math.max(0, volume));
    }
  }, [muted, volume]);
  return <audio ref={ref} autoPlay style={{ display: "none" }} />;
}
