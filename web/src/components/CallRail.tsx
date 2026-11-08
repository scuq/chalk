// 131-1: the call rail. A 48px column left of the sidebar for as long as you
// are in a call on a desktop. Since 131-7 it is the whole call surface, in
// three parts from top to bottom:
//   - the head: the duration, the live dot, and the audio nudge.
//   - the tiles: one 40px tile per participant and per screen share. They
//     show only while the call room is not the channel on screen.
//   - the foot: microphone, headphones, camera, share, settings, and leave.
// The sidebar runs to the bottom of the window beside it.

import { useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import { railTiles, type RailTile } from "../voice/rail-tiles";
import { fmtDuration } from "../voice/duration";
import type { ChannelSummary, VoiceParticipant } from "../state/types";
import { Avatar } from "./Avatar";
import { occupantName } from "./Sidebar";
import { DeafIcon, MicOffIcon, ScreenIcon } from "./VoiceBadges";
import { useVoiceSession } from "./VoiceDock";
import { voiceSession } from "../voice/session";
import {
  IconCamera,
  IconGear,
  IconHeadphones,
  IconLeave,
  IconMic,
  IconScreen,
  toggleCamOrEnable,
} from "./VoiceControls";

interface Props {
  /** The channel on screen. On the room's own page the tiles are not drawn. */
  activeChannelID: string | null;
  onJumpToChannel: (channelID: string) => void;
  onOpenMicSettings: () => void;
  channels: Record<string, ChannelSummary>;
  voiceRosters: Record<string, VoiceParticipant[]>;
  avatars: Record<string, Record<string, string>>;
  attachmentController: AttachmentController | null;
  selfUserID: string;
  selfDeviceID: string;
}

export function CallRail({
  activeChannelID,
  onJumpToChannel,
  onOpenMicSettings,
  channels,
  voiceRosters,
  avatars,
  attachmentController,
  selfUserID,
  selfDeviceID,
}: Props) {
  const snap = useVoiceSession();
  const [, setTick] = useState(0);

  // One tick a second keeps the duration and hasLiveVideo current.
  useEffect(() => {
    if (snap.phase !== "in-call") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [snap.phase]);

  const roomID = snap.channelID;
  if (snap.phase === "idle" || !roomID) return null;

  const inCall = snap.phase === "in-call";
  // 131-7: on the room's own page the stage shows everyone. The tiles box
  // stays as the spacer that keeps the foot at the bottom.
  const showTiles = activeChannelID !== roomID;
  const ch: ChannelSummary | undefined = channels[roomID];
  const roster = voiceRosters[roomID] ?? [];
  const tiles = showTiles ? railTiles(snap, roster, selfUserID, selfDeviceID) : [];
  const pictures = avatars[roomID] ?? {};
  const selfHandle = ch?.members?.find((m) => m.userID === selfUserID)?.handle || "y";
  const jumpBack = () => onJumpToChannel(roomID);

  const nameFor = (t: RailTile): string =>
    ch ? occupantName(ch, selfUserID, t.userID) : t.userID.slice(0, 8);

  return (
    <aside class="chalk-call-rail" data-testid="call-rail" aria-label="the call">
      {/* 131-7: the head. The duration is the way back to the room. */}
      <div class="chalk-call-rail-head" data-testid="call-rail-head">
        <button
          class="chalk-call-rail-time"
          type="button"
          onClick={jumpBack}
          title={`${snap.channelName || "voice"} · back to the room (Ctrl+Shift+V)`}
          data-testid="call-rail-duration"
        >
          {inCall && snap.joinedAt !== null ? fmtDuration(Date.now() - snap.joinedAt) : "…"}
        </button>
        {snap.audioBlocked && (
          <span
            class="chalk-call-rail-nudge chalk-voice-audionudge"
            title="click anywhere to enable audio"
            data-testid="call-rail-nudge"
          >
            🔇
          </span>
        )}
      </div>
      <div class="chalk-call-rail-tiles">
      {tiles.map((t) => {
        const name = nameFor(t);
        const speaking =
          !t.isScreen && (t.isSelf ? snap.micOpen && !snap.muted : !!snap.speaking[t.key]);
        const states: string[] = [];
        if (t.isScreen) states.push("screen");
        else if (t.part?.deafened) states.push("deafened");
        else if (t.part?.muted) states.push("muted");
        const title = states.length > 0 ? `${name} (${states.join(", ")})` : name;
        const initial = (t.isSelf ? selfHandle : name).slice(0, 1).toUpperCase();
        const pictureID = t.isScreen ? null : (pictures[t.userID] ?? null);
        const video = t.hasLiveVideo && t.stream;
        return (
          <button
            key={t.key}
            type="button"
            class={"chalk-call-tile" + (speaking ? " chalk-call-tile--speaking" : "")}
            title={`${title} · back to the room`}
            aria-label={title}
            data-testid="call-rail-tile"
            data-peer={t.key}
            data-video={video ? "true" : "false"}
            onClick={jumpBack}
          >
            {video ? (
              <RailVideo stream={t.stream!} mirrored={t.isSelf && !t.isScreen} />
            ) : (
              <span class="chalk-voice-avatar" aria-hidden="true">
                {/* 131-5: the initial is always there. The picture draws over
                    it once it resolves, so a tile is never a blank box. */}
                {initial}
                {pictureID && (
                  <Avatar
                    channelID={roomID}
                    attachmentID={pictureID}
                    controller={attachmentController}
                    size="tile"
                    userID={t.userID}
                    live
                  />
                )}
              </span>
            )}
            {t.isScreen ? (
              <span class="chalk-call-tile-badge">
                <ScreenIcon />
              </span>
            ) : t.part?.deafened ? (
              <span class="chalk-call-tile-badge">
                <DeafIcon />
              </span>
            ) : t.part?.muted ? (
              <span class="chalk-call-tile-badge">
                <MicOffIcon />
              </span>
            ) : null}
          </button>
        );
      })}
      </div>
      {/* 131-6, 131-7: the controls at the foot, always in view, leave last. */}
      <div class="chalk-call-rail-foot" data-testid="call-rail-foot">
        <button
          class={"chalk-call-rail-btn" + (snap.muted ? " is-off" : "")}
          type="button"
          onClick={() => voiceSession.toggleMute()}
          title={snap.muted ? "unmute microphone" : "mute microphone"}
          aria-pressed={snap.muted}
          aria-label={snap.muted ? "unmute microphone" : "mute microphone"}
          data-testid="call-rail-mute"
        >
          <IconMic off={snap.muted} size={22} />
        </button>
        <button
          class={"chalk-call-rail-btn" + (snap.deafened ? " is-off" : "")}
          type="button"
          onClick={() => voiceSession.toggleDeafen()}
          title={snap.deafened ? "hear everyone again" : "deafen: silence everyone, and you"}
          aria-pressed={snap.deafened}
          aria-label={snap.deafened ? "hear everyone again" : "deafen everyone"}
          data-testid="call-rail-deafen"
        >
          <IconHeadphones off={snap.deafened} size={22} />
        </button>
        <button
          class={"chalk-call-rail-btn" + (snap.camOn ? "" : " is-off")}
          type="button"
          onClick={toggleCamOrEnable}
          title={snap.camOn ? "turn the camera off" : "turn the camera on"}
          aria-pressed={snap.camOn}
          aria-label={snap.camOn ? "turn the camera off" : "turn the camera on"}
          data-testid="call-rail-cam"
        >
          <IconCamera off={!snap.camOn} size={22} />
        </button>
        <button
          class={"chalk-call-rail-btn" + (snap.sharing ? " is-on" : "")}
          type="button"
          disabled={!inCall}
          onClick={() => void voiceSession.toggleScreenShare()}
          title={snap.sharing ? "stop sharing your screen" : "share a screen, window, or tab"}
          aria-pressed={snap.sharing}
          aria-label={snap.sharing ? "stop sharing your screen" : "share your screen"}
          data-testid="call-rail-share"
        >
          <IconScreen size={22} />
        </button>
        <button
          class="chalk-call-rail-btn"
          type="button"
          onClick={onOpenMicSettings}
          title="voice and video settings"
          aria-label="voice and video settings"
          data-testid="call-rail-settings"
        >
          <IconGear size={22} />
        </button>
        <button
          class="chalk-call-rail-btn chalk-call-rail-btn--leave"
          type="button"
          onClick={() => void voiceSession.leave()}
          title="disconnect from voice"
          aria-label="disconnect from voice"
          data-testid="call-rail-leave"
        >
          <IconLeave size={22} />
        </button>
      </div>
    </aside>
  );
}

// The video element of a tile. Muted: audio plays through the dock's sinks.
function RailVideo({ stream, mirrored }: { stream: MediaStream; mirrored: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <video
      ref={ref}
      class={"chalk-call-tile-video" + (mirrored ? " chalk-voice-video-mirrored" : "")}
      autoPlay
      playsInline
      muted
    />
  );
}
