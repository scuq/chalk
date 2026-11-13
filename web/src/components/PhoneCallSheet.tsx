// 135-5: the phone's call view. A full-screen layer over the screen under
// it. Before you join it shows who is in the room and a join button. In the
// call it shows everybody (voice/phone-call.ts decides where) and the
// controls. The arrow, a swipe down on the head, and the back gesture close
// it. Only the leave button ends the call.

import { useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import type { ChannelSummary, VoiceParticipant } from "../state/types";
import { voiceSession } from "../voice/session";
import { fmtDuration } from "../voice/duration";
import { railTiles, type RailTile } from "../voice/rail-tiles";
import { callLayout, canShareScreen, cardColumns, stageGrid } from "../voice/phone-call";
import { Avatar } from "./Avatar";
import { occupantName } from "./Sidebar";
import { DeafIcon, MicOffIcon, ScreenIcon } from "./VoiceBadges";
import { useVoiceSession } from "./VoiceDock";
import { describeJoinError } from "./VoiceCallPanel";
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
  roomID: string;
  room: ChannelSummary | undefined;
  roster: VoiceParticipant[];
  /** The pictures in this room, by user. */
  avatars: Record<string, string>;
  attachmentController: AttachmentController | null;
  selfUserID: string;
  selfDeviceID: string;
  /** The room key is ready, so a join can start. */
  keyReady: boolean;
  /** The room's chat has messages you have not read. */
  chatUnread: boolean;
  onJoin: () => void;
  onClose: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
}

// A swipe down on the head that goes past this closes the view.
const CLOSE_DRAG_PX = 90;
// Two taps on a video within this time show it large.
const DOUBLE_TAP_MS = 280;

/** PhoneCallSheet draws the call view of one room. */
export function PhoneCallSheet(p: Props) {
  const snap = useVoiceSession();
  const [, setTick] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [personKey, setPersonKey] = useState<string | null>(null);
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const tapTimer = useRef<number | null>(null);

  const inCall = snap.phase === "in-call" && snap.channelID === p.roomID;
  const joining = snap.phase === "joining" && snap.channelID === p.roomID;
  const elsewhere = snap.phase !== "idle" && snap.channelID !== p.roomID;

  useEffect(() => {
    if (!inCall) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [inCall]);
  useEffect(() => () => {
    if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
  }, []);

  const name = p.room?.name || snap.channelName || "voice";
  const nameOf = (userID: string) => (p.room ? occupantName(p.room, p.selfUserID, userID) : userID.slice(0, 8));
  const tileName = (t: RailTile) => (t.isScreen ? `${nameOf(t.userID)}'s screen` : nameOf(t.userID));
  const speaking = (t: RailTile) =>
    !t.isScreen && (t.isSelf ? snap.micOpen && !snap.muted : !!snap.speaking[t.key]);

  const tiles = inCall ? railTiles(snap, p.roster, p.selfUserID, p.selfDeviceID) : [];
  const layout = callLayout(tiles, focusKey);
  const person = personKey ? tiles.find((t) => t.key === personKey) : undefined;

  // A video waits for a second tap before it opens the sheet, so a double
  // tap can show it large. A card opens the sheet at once.
  const tapTile = (t: RailTile) => {
    if (!t.hasLiveVideo || t.isSelf) {
      if (!t.isSelf) setPersonKey(t.key);
      return;
    }
    if (tapTimer.current !== null) {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = null;
      setFocusKey((k) => (k === t.key ? null : t.key));
      return;
    }
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = null;
      setPersonKey(t.key);
    }, DOUBLE_TAP_MS);
  };

  const onHeadDown = (e: PointerEvent) => {
    dragFrom.current = e.clientY;
  };
  const onHeadMove = (e: PointerEvent) => {
    if (dragFrom.current === null) return;
    setDrag(Math.max(0, e.clientY - dragFrom.current));
  };
  const onHeadUp = () => {
    if (dragFrom.current === null) return;
    dragFrom.current = null;
    if (drag > CLOSE_DRAG_PX) p.onClose();
    setDrag(0);
  };

  const badge = (t: RailTile) =>
    t.isScreen ? <ScreenIcon /> : t.part?.deafened ? <DeafIcon /> : t.part?.muted ? <MicOffIcon /> : null;
  const level = (
    <span class="chalk-pcall-level" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
  const face = (t: RailTile) => {
    const picture = t.isScreen ? null : (p.avatars[t.userID] ?? null);
    return (
      <span class="chalk-pcall-face" aria-hidden="true">
        {tileName(t).slice(0, 1).toUpperCase()}
        {picture && (
          <Avatar
            channelID={p.roomID}
            attachmentID={picture}
            controller={p.attachmentController}
            size="tile"
            userID={t.userID}
            live
          />
        )}
      </span>
    );
  };

  const cols = cardColumns(layout.stage.length);
  const grid = stageGrid(layout.stage.length);

  return (
    <div
      class="chalk-pcall"
      role="dialog"
      aria-label={`call in ${name}`}
      data-testid="phone-call"
      style={drag > 0 ? `transform:translateY(${drag}px)` : undefined}
    >
      <div
        class="chalk-pcall-head"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        onPointerCancel={onHeadUp}
      >
        <span class="chalk-pcall-grip" aria-hidden="true" />
        <button type="button" class="chalk-pcall-btn chalk-pcall-btn--flat" onClick={p.onClose} aria-label="close the call view" data-testid="phone-call-close">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 9l7 7 7-7" />
          </svg>
        </button>
        <span class="chalk-pcall-title">{name}</span>
        <span class="chalk-pcall-time" data-testid="phone-call-time">
          {inCall && snap.joinedAt !== null ? fmtDuration(Date.now() - snap.joinedAt) : ""}
        </span>
        <button type="button" class="chalk-pcall-btn chalk-pcall-btn--flat" onClick={p.onOpenSettings} aria-label="voice and video settings" data-testid="phone-call-settings">
          <IconGear size={22} />
        </button>
      </div>

      {!inCall ? (
        <div class="chalk-pcall-lobby" data-testid="phone-call-lobby">
          <div class="chalk-pcall-lobby-name">{name}</div>
          <div class="chalk-pcall-note">
            {p.roster.length === 0
              ? "nobody is here yet"
              : p.roster.length === 1
                ? "1 person is here"
                : `${p.roster.length} people are here`}
          </div>
          {p.roster.length > 0 && (
            <div class="chalk-pcall-lobby-faces">
              {p.roster.slice(0, 8).map((r) => (
                <span key={r.userID + ":" + r.deviceID} class="chalk-pcall-face" title={nameOf(r.userID)}>
                  {nameOf(r.userID).slice(0, 1).toUpperCase()}
                  {p.avatars[r.userID] && (
                    <Avatar channelID={p.roomID} attachmentID={p.avatars[r.userID]} controller={p.attachmentController} size="tile" userID={r.userID} live />
                  )}
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            class="chalk-pcall-join"
            disabled={joining || !p.keyReady}
            onClick={p.onJoin}
            data-testid="phone-call-join"
          >
            <IconMic size={22} />
            {joining ? "joining…" : "join"}
          </button>
          {elsewhere && (
            <div class="chalk-pcall-note" data-testid="phone-call-elsewhere">
              you are in {snap.channelName || "another room"}. join moves you here.
            </div>
          )}
          {!p.keyReady && <div class="chalk-pcall-note">waiting for the room key…</div>}
          {snap.error && <div class="chalk-pcall-error">{describeJoinError(snap.error)}</div>}
        </div>
      ) : layout.mode === "audio" ? (
        <div class={`chalk-pcall-cards chalk-pcall-cards--${cols}`} data-testid="phone-call-cards">
          {layout.stage.map((t) => (
            <button
              key={t.key}
              type="button"
              class={"chalk-pcall-card" + (speaking(t) ? " chalk-pcall--speaking" : "")}
              onClick={() => tapTile(t)}
              aria-label={tileName(t)}
              data-testid="phone-call-card"
              data-peer={t.key}
            >
              {t.hasLiveVideo && t.stream && <TileVideo stream={t.stream} mirrored={t.isSelf} />}
              <span class="chalk-pcall-name">{tileName(t)}</span>
              <span class="chalk-pcall-badge">{badge(t)}</span>
              {face(t)}
              {level}
            </button>
          ))}
        </div>
      ) : (
        <div class="chalk-pcall-videomode" data-testid="phone-call-video">
          <div class="chalk-pcall-stage" style={`grid-template-columns:repeat(${grid.cols},1fr);grid-template-rows:repeat(${grid.rows},1fr)`}>
            {layout.stage.map((t) => (
              <button
                key={t.key}
                type="button"
                class={"chalk-pcall-video" + (speaking(t) ? " chalk-pcall--speaking" : "")}
                onClick={() => tapTile(t)}
                aria-label={tileName(t)}
                data-testid="phone-call-videotile"
                data-peer={t.key}
              >
                {t.stream && <TileVideo stream={t.stream} mirrored={false} />}
                <span class="chalk-pcall-label">
                  {tileName(t)}
                  {speaking(t) && level}
                  {badge(t)}
                </span>
              </button>
            ))}
            {layout.corner?.stream && (
              <div class="chalk-pcall-corner" data-testid="phone-call-corner">
                <TileVideo stream={layout.corner.stream} mirrored />
              </div>
            )}
          </div>
          {layout.strip.length > 0 && (
            <div class="chalk-pcall-strip">
              {layout.strip.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  class={"chalk-pcall-chip" + (speaking(t) ? " chalk-pcall--speaking" : "")}
                  onClick={() => tapTile(t)}
                  aria-label={tileName(t)}
                  data-testid="phone-call-chip"
                  data-peer={t.key}
                >
                  {face(t)}
                  <span class="chalk-pcall-name">{tileName(t)}</span>
                  <span class="chalk-pcall-badge">{badge(t)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {inCall && snap.error && <div class="chalk-pcall-error">{snap.error}</div>}
      {snap.audioBlocked && inCall && (
        <div class="chalk-pcall-note chalk-pcall-nudge" data-testid="phone-call-nudge">
          tap anywhere to turn on the sound
        </div>
      )}

      <div class="chalk-pcall-foot">
        <div class="chalk-pcall-foot-row">
          <button type="button" class="chalk-pcall-chat" onClick={p.onOpenChat} data-testid="phone-call-chat">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 5h16v11H9l-5 4z" />
            </svg>
            chat
            {p.chatUnread && <span class="chalk-pcall-dot" aria-label="unread messages" />}
          </button>
        </div>
        {inCall && (
          <div class="chalk-pcall-controls" data-testid="phone-call-controls">
            <button
              type="button"
              class={"chalk-pcall-ctl" + (snap.muted ? " chalk-pcall-ctl--off" : "")}
              onClick={() => voiceSession.toggleMute()}
              aria-pressed={snap.muted}
              data-testid="phone-call-mute"
            >
              <IconMic off={snap.muted} size={24} />
              <span>{snap.muted ? "muted" : "mute"}</span>
            </button>
            <button
              type="button"
              class={"chalk-pcall-ctl" + (snap.deafened ? " chalk-pcall-ctl--off" : "")}
              onClick={() => voiceSession.toggleDeafen()}
              aria-pressed={snap.deafened}
              data-testid="phone-call-deafen"
            >
              <IconHeadphones off={snap.deafened} size={24} />
              <span>{snap.deafened ? "deafened" : "deafen"}</span>
            </button>
            <button
              type="button"
              class={"chalk-pcall-ctl" + (snap.camOn ? " chalk-pcall-ctl--on" : "")}
              onClick={toggleCamOrEnable}
              aria-pressed={snap.camOn}
              data-testid="phone-call-cam"
            >
              <IconCamera off={!snap.camOn} size={24} />
              <span>camera</span>
            </button>
            {canShareScreen(typeof navigator !== "undefined" ? navigator.mediaDevices : undefined) && (
              <button
                type="button"
                class={"chalk-pcall-ctl" + (snap.sharing ? " chalk-pcall-ctl--on" : "")}
                onClick={() => void voiceSession.toggleScreenShare()}
                aria-pressed={snap.sharing}
                data-testid="phone-call-share"
              >
                <IconScreen size={24} />
                <span>{snap.sharing ? "sharing" : "share"}</span>
              </button>
            )}
            <button
              type="button"
              class="chalk-pcall-ctl chalk-pcall-ctl--leave"
              onClick={() => void voiceSession.leave()}
              data-testid="phone-call-leave"
            >
              <IconLeave size={24} />
              <span>leave</span>
            </button>
          </div>
        )}
      </div>

      {person && (
        <div class="chalk-pcall-sheet-backdrop" onClick={() => setPersonKey(null)} data-testid="phone-call-person">
          <div class="chalk-pcall-sheet" onClick={(e) => e.stopPropagation()}>
            <span class="chalk-pcall-grip" aria-hidden="true" />
            <div class="chalk-pcall-sheet-head">{tileName(person)}</div>
            {person.isScreen ? (
              <PersonAudio
                volume={voiceSession.peerAudioFor(person.userID).screenVolume ?? 1}
                muted={!!voiceSession.peerAudioFor(person.userID).screenMuted}
                onVolume={(v) => voiceSession.setPeerScreenVolume(person.userID, v)}
                onMute={(m) => voiceSession.setPeerScreenLocalMute(person.userID, m)}
              />
            ) : (
              <PersonAudio
                volume={voiceSession.peerAudioFor(person.userID).volume ?? 1}
                muted={!!voiceSession.peerAudioFor(person.userID).muted}
                onVolume={(v) => voiceSession.setPeerVolume(person.userID, v)}
                onMute={(m) => voiceSession.setPeerLocalMute(person.userID, m)}
              />
            )}
            {person.hasLiveVideo && (
              <button
                type="button"
                class="chalk-pcall-sheet-item"
                onClick={() => {
                  setFocusKey((k) => (k === person.key ? null : person.key));
                  setPersonKey(null);
                }}
                data-testid="phone-call-person-large"
              >
                {focusKey === person.key ? "show everybody" : "show large"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// The volume of one person (or of their shared screen) and the switch that
// mutes them on this device only.
function PersonAudio({
  volume,
  muted,
  onVolume,
  onMute,
}: {
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onMute: (m: boolean) => void;
}) {
  return (
    <>
      <label class="chalk-pcall-sheet-item">
        volume
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(volume * 100)}
          onInput={(e) => onVolume(Number((e.target as HTMLInputElement).value) / 100)}
          data-testid="phone-call-person-volume"
        />
        <span class="chalk-pcall-sheet-value">{Math.round(volume * 100)}%</span>
      </label>
      <button type="button" class="chalk-pcall-sheet-item" onClick={() => onMute(!muted)} aria-pressed={muted} data-testid="phone-call-person-mute">
        {muted ? "unmute for me" : "mute for me"}
      </button>
    </>
  );
}

// A video of the call. Muted: the sound plays through VoiceSinks.
function TileVideo({ stream, mirrored }: { stream: MediaStream; mirrored: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      class={"chalk-pcall-videoel" + (mirrored ? " chalk-voice-video-mirrored" : "")}
      autoPlay
      playsInline
      muted
    />
  );
}
