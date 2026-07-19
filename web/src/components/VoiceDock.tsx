// VoiceDock (Phase 30, slices 30-5c + 30-5f): the Discord bottom-left
// connection panel, mounted ONCE at the app level (bottom of the sidebar).
//
// Jobs:
//   1. AUDIO. The hidden <audio> sinks for every remote peer live HERE, not
//      in the per-channel panel -- that is the whole point of a persistent
//      call: sound keeps flowing while you read a text channel. Each sink
//      applies the peer's LOCAL prefs (A1 mute + A4-subset volume).
//   2. THE BAR. While connected: "voice connected" + room name (click jumps
//      back to the room), live duration, mute toggle, disconnect.
//   3. (30-5f) MICRO PiP. When you're connected to a voice room but looking
//      at a DIFFERENT channel, the dock shows a tiny live video of the
//      focused speaker (or a monogram when audio-only) -- Discord's picture
//      the moment you leave the call view. Clicking it, the room name, or
//      pressing the jump shortcut snaps you back to the room.
//
// The focus rule mirrors the panel's stage: first remote with live video,
// else first remote, else self.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { voiceSession, type SessionRemoteTile, type VoiceSessionSnap } from "../voice/session";
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

interface Props {
  onJumpToChannel: (channelID: string) => void;
  /** The channel currently on screen. When it differs from the connected
   * voice room, the dock shows the PiP preview + jump-back affordance. */
  activeChannelID: string | null;
}

// PiP focus discriminated union: a remote tile or the local stream.
type PiPTile =
  | { kind: "remote"; tile: SessionRemoteTile; hasVideo: boolean }
  | { kind: "self"; stream: MediaStream | null; hasVideo: boolean };

export function VoiceDock({ onJumpToChannel, activeChannelID }: Props) {
  const snap = useVoiceSession();
  const [, setTick] = useState(0);

  // Duration ticker while connected. Also keeps the PiP focus fresh as
  // tracks start/stop (getVideoTracks() is polled via this re-render).
  useEffect(() => {
    if (snap.phase !== "in-call") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [snap.phase]);

  const jumpBack = () => {
    if (snap.channelID) onJumpToChannel(snap.channelID);
  };

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

  // Viewing a different channel than the one we're connected to?
  const viewingElsewhere =
    snap.phase === "in-call" && snap.channelID !== null && activeChannelID !== snap.channelID;

  // Focused tile for the PiP (same rule as the stage). Self is a valid
  // fallback so a solo call still previews your own camera.
  const focused: PiPTile | null = useMemo(() => {
    if (snap.phase !== "in-call") return null;
    const remotes = Object.values(snap.tiles);
    const withVideo = remotes.find((t) =>
      t.stream.getVideoTracks().some((v) => v.readyState === "live"),
    );
    if (withVideo) return { kind: "remote", tile: withVideo, hasVideo: true };
    if (remotes.length > 0) return { kind: "remote", tile: remotes[0], hasVideo: false };
    // Solo: preview self if the camera is on.
    if (
      snap.camOn &&
      snap.localStream &&
      snap.localStream.getVideoTracks().some((v) => v.enabled && v.readyState === "live")
    ) {
      return { kind: "self", stream: snap.localStream, hasVideo: true };
    }
    return { kind: "self", stream: snap.localStream, hasVideo: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.phase, snap.tiles, snap.localStream, snap.camOn]);

  return (
    <>
      {/* Job 1: app-level audio, always rendered while tiles exist. */}
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

      {/* Job 2/3: the connection bar (+ PiP when viewing elsewhere). */}
      {snap.phase !== "idle" && (
        <div class="chalk-voice-dock" data-testid="voice-dock">
          {/* 30-5f: micro video preview, only when you're looking away from
              the room. Clicking it jumps back. */}
          {viewingElsewhere && focused && (
            <button
              class="chalk-voice-pip"
              type="button"
              onClick={jumpBack}
              title="back to the voice room (Ctrl+Shift+V)"
              data-testid="voice-dock-pip"
            >
              {focused.hasVideo ? (
                <PiPVideo
                  stream={focused.kind === "remote" ? focused.tile.stream : focused.stream}
                  mirrored={focused.kind === "self"}
                />
              ) : (
                <span class="chalk-voice-pip-mono" aria-hidden="true">
                  {pipInitial(focused)}
                </span>
              )}
              <span class="chalk-voice-pip-hint">▸ back</span>
            </button>
          )}

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
          {snap.audioBlocked && (
            <div class="chalk-voice-dock-row chalk-voice-audionudge" data-testid="voice-audio-nudge">
              🔇 click anywhere to enable audio
            </div>
          )}
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

function pipInitial(focused: PiPTile): string {
  if (focused.kind === "self") return "y";
  // Remote: first char of the userID as a cheap monogram; the dock has no
  // member list to resolve handles, and the stage carries the real name.
  return focused.tile.userID.slice(0, 1).toUpperCase();
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
      // 30-5i: after an auto-rejoin there's been no user gesture, so the
      // browser's autoplay policy may reject playback. Detect it and flag
      // the dock nudge; a global click (below) resumes.
      const p = ref.current.play?.();
      if (p && typeof p.catch === "function") {
        p.catch(() => voiceSession.notifyAudioBlocked());
      }
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

function PiPVideo({ stream, mirrored }: { stream: MediaStream | null; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && stream && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  // Muted: audio flows through the AudioSinks; this element is video only.
  return (
    <video
      ref={ref}
      class={"chalk-voice-pip-video" + (mirrored ? " chalk-voice-video-mirrored" : "")}
      autoPlay
      playsInline
      muted
    />
  );
}
