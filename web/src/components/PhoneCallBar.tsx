// 135-5: the phone's call bar. It shows on every phone screen except the
// call view, above the composer, while you are in a call or joining one.
// A tap on the room opens the call view. Mute and leave are on the bar.

import { useEffect, useState } from "preact/hooks";
import type { ChannelSummary } from "../state/types";
import { voiceSession } from "../voice/session";
import { fmtDuration } from "../voice/duration";
import { barLine } from "../voice/phone-call";
import { occupantName } from "./Sidebar";
import { useVoiceSession } from "./VoiceDock";
import { IconLeave, IconMic } from "./VoiceControls";

interface Props {
  /** The room of the call, for the names of the people who speak. */
  room: ChannelSummary | undefined;
  selfUserID: string;
  onOpen: (roomID: string) => void;
}

/** PhoneCallBar draws the call bar. It renders nothing while no call runs. */
export function PhoneCallBar({ room, selfUserID, onOpen }: Props) {
  const snap = useVoiceSession();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (snap.phase !== "in-call") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [snap.phase]);

  const roomID = snap.channelID;
  if (snap.phase === "idle" || !roomID) return null;

  const speakers: string[] = [];
  for (const [key, on] of Object.entries(snap.speaking)) {
    const userID = key.split(":")[0];
    if (!on || userID === selfUserID) continue;
    const name = room ? occupantName(room, selfUserID, userID) : userID.slice(0, 8);
    if (!speakers.includes(name)) speakers.push(name);
  }
  const name = snap.channelName || room?.name || "voice";
  const time = snap.phase === "in-call" && snap.joinedAt !== null ? fmtDuration(Date.now() - snap.joinedAt) : "…";
  const live = speakers.length > 0 || (snap.micOpen && !snap.muted);

  return (
    <div class="chalk-pcall-bar" data-testid="phone-callbar">
      <button
        type="button"
        class="chalk-pcall-bar-open"
        onClick={() => onOpen(roomID)}
        aria-label={`open the call in ${name}`}
        data-testid="phone-callbar-open"
      >
        <span class={"chalk-pcall-level" + (live ? " chalk-pcall-level--on" : "")} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span class="chalk-pcall-bar-text">
          <span class="chalk-pcall-bar-room">
            {name} · <span data-testid="phone-callbar-time">{time}</span>
          </span>
          <span class="chalk-pcall-bar-line" data-testid="phone-callbar-line">
            {barLine({ phase: snap.phase, muted: snap.muted, audioBlocked: snap.audioBlocked, speaking: speakers })}
          </span>
        </span>
      </button>
      <button
        type="button"
        class={"chalk-pcall-btn" + (snap.muted ? " chalk-pcall-btn--off" : "")}
        onClick={() => voiceSession.toggleMute()}
        aria-pressed={snap.muted}
        aria-label={snap.muted ? "unmute microphone" : "mute microphone"}
        data-testid="phone-callbar-mute"
      >
        <IconMic off={snap.muted} size={22} />
      </button>
      <button
        type="button"
        class="chalk-pcall-btn chalk-pcall-btn--leave"
        onClick={() => void voiceSession.leave()}
        aria-label="leave the call"
        data-testid="phone-callbar-leave"
      >
        <IconLeave size={22} />
      </button>
    </div>
  );
}
