// 131-1: the call rail. A 48px column left of the sidebar, one 40px tile
// per participant and per screen share, for as long as you are in a call.
//
// The rail replaced the dock's one-camera preview. It shows only while the
// call room is not the channel on screen (131-5). On the room's own page the
// stage shows everyone and plays the video. A click on a tile jumps back to
// the room.

import { useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import { railTiles, type RailTile } from "../voice/rail-tiles";
import type { ChannelSummary, VoiceParticipant } from "../state/types";
import { Avatar } from "./Avatar";
import { occupantName } from "./Sidebar";
import { DeafIcon, MicOffIcon, ScreenIcon } from "./VoiceBadges";
import { useVoiceSession } from "./VoiceDock";

interface Props {
  onJumpToChannel: (channelID: string) => void;
  channels: Record<string, ChannelSummary>;
  voiceRosters: Record<string, VoiceParticipant[]>;
  avatars: Record<string, Record<string, string>>;
  attachmentController: AttachmentController | null;
  selfUserID: string;
  selfDeviceID: string;
}

export function CallRail({
  onJumpToChannel,
  channels,
  voiceRosters,
  avatars,
  attachmentController,
  selfUserID,
  selfDeviceID,
}: Props) {
  const snap = useVoiceSession();
  const [, setTick] = useState(0);

  // One tick a second keeps hasLiveVideo current as tracks start and stop.
  useEffect(() => {
    if (snap.phase !== "in-call") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [snap.phase]);

  const roomID = snap.channelID;
  if (snap.phase === "idle" || !roomID) return null;

  const ch: ChannelSummary | undefined = channels[roomID];
  const roster = voiceRosters[roomID] ?? [];
  const tiles = railTiles(snap, roster, selfUserID, selfDeviceID);
  const pictures = avatars[roomID] ?? {};
  const selfHandle = ch?.members?.find((m) => m.userID === selfUserID)?.handle || "y";

  const nameFor = (t: RailTile): string =>
    ch ? occupantName(ch, selfUserID, t.userID) : t.userID.slice(0, 8);

  return (
    <aside class="chalk-call-rail" data-testid="call-rail" aria-label="people in the call">
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
            onClick={() => onJumpToChannel(roomID)}
          >
            {video ? (
              <RailVideo stream={t.stream!} mirrored={t.isSelf && !t.isScreen} />
            ) : (
              <span class="chalk-voice-avatar" aria-hidden="true">
                {/* 131-5: a tile always draws the initial. The picture draws
                    over it when it resolves, so a tile is never blank. */}
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
