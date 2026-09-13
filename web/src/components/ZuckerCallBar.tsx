// ZuckerCallBar (126-2): the phone home screen's own voice bar.
//
// VoiceDock owns live audio: the hidden <audio> sinks for every peer, the
// boost graph, the pop-out cleanup, and the autoplay-resume handler. It
// mounts once, inside the sidebar. Zuckermode hides the sidebar -- it is a
// fixed drawer translated off-screen, and the nav toggle is display: none --
// so the dock's own bar and leave button are unreachable there.
//
// The alternative is moving the dock into the footer under zuckerActive.
// That remounts it on every layout flip: a phone rotated to landscape
// crosses the 767px breakpoint, and a remount recreates the audio sinks
// mid-call. So the dock stays where it is and keeps doing audio, and this
// component reads the same session snapshot (useVoiceSession, exported from
// VoiceDock) to show a bar of its own on the screen the dock cannot reach.
//
// Renders nothing while idle. Otherwise, one row: the room glyph and name
// (jumps back to the room and switches the zucker screen to "chat"), a "▸"
// hint when you are looking at something else, the running duration or
// "joining…", the live dot while the microphone is open and not muted, and
// a leave button. It reuses the dock's classes so it reads as the same
// control.

import { useEffect, useState } from "preact/hooks";
import { voiceSession } from "../voice/session";
import { fmtDuration } from "../voice/duration";
import { ChannelGlyph } from "./Sidebar";
import { useVoiceSession } from "./VoiceDock";

interface Props {
  /** The channel on screen right now, or null for no channel on screen
   * (the list screen). Compared against the connected voice room to decide
   * if the "▸" back hint shows. */
  activeChannelID: string | null;
  /** Switches the active channel and the zucker screen to "chat". */
  onJumpToChannel: (channelID: string) => void;
}

export function ZuckerCallBar({ activeChannelID, onJumpToChannel }: Props) {
  const snap = useVoiceSession();
  const [, setTick] = useState(0);

  // Re-renders once a second for the running duration below, the same way
  // the dock ticks its own copy.
  useEffect(() => {
    if (snap.phase !== "in-call") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [snap.phase]);

  if (snap.phase === "idle") return null;

  const inCall = snap.phase === "in-call";
  // True once the room you are connected to is not the room on screen --
  // the case the "▸" hint and the "back to the voice room" title answer.
  const elsewhere = snap.channelID !== null && activeChannelID !== snap.channelID;

  return (
    <div class="chalk-voice-dock chalk-zucker-callbar" data-testid="zucker-callbar">
      {snap.audioBlocked && (
        // 30-5i: the dock shows this same "tap to enable audio" nudge, but
        // the dock sits inside the hidden drawer here, so the bar needs its
        // own copy.
        <div class="chalk-voice-dock-row chalk-voice-audionudge" data-testid="zucker-callbar-nudge">
          🔇 tap anywhere to enable audio
        </div>
      )}
      <div class="chalk-voice-dock-row">
        <button
          class="chalk-voice-dock-channel"
          type="button"
          onClick={() => {
            if (snap.channelID) onJumpToChannel(snap.channelID);
          }}
          title={elsewhere ? "back to the voice room" : "the voice room you are in"}
          data-testid="zucker-callbar-channel"
          data-elsewhere={elsewhere ? "true" : "false"}
        >
          <span class="chalk-chglyph chalk-chglyph--voice chalk-chglyph--inline">
            <ChannelGlyph type="voice" />
          </span>
          <span class="chalk-voice-dock-channame">{snap.channelName || "voice"}</span>
          {elsewhere && <span class="chalk-zucker-callbar-hint">▸</span>}
        </button>
        <span class="chalk-voice-dock-spacer" />
        {inCall && snap.joinedAt !== null ? (
          <span class="chalk-voice-dock-duration" data-testid="zucker-callbar-duration">
            {fmtDuration(Date.now() - snap.joinedAt)}
          </span>
        ) : (
          <span class="chalk-voice-dock-status" data-connected="false">
            joining…
          </span>
        )}
        {!snap.muted && snap.micOpen && (
          // 41-5: the same live dot the dock shows while your microphone is
          // open and not muted.
          <span class="chalk-voice-live" title="your microphone is transmitting" />
        )}
        <button
          class="chalk-btn chalk-voice-ctl chalk-voice-ctl--leave"
          type="button"
          onClick={() => void voiceSession.leave()}
          title="disconnect from voice"
          aria-label="disconnect from voice"
          data-testid="zucker-callbar-leave"
        >
          leave
        </button>
      </div>
    </div>
  );
}
