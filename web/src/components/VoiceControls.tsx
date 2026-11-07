// VoiceControls (44-2): the panel of mute, deafen, camera, share, and
// settings. Since 131-7 it is the phone's control bar and renders only there.
// On desktop the call rail carries the same five controls and leave, so only
// one set of controls is on screen.
//
// The point of it being always present is that all three toggles are GLOBAL
// (see voiceSession's setGlobal): outside a call they set the state the next
// room is joined in, inside a call they act on the live call as well. So you
// mute yourself before walking into the room, the way you would reach for the
// mute switch before putting the headset on -- rather than joining hot and
// scrambling for the dock's button. Since 131-7 this argument holds on the
// phone only. On desktop the pre-join defaults are in settings, voice.
//
// 44-6: a bordered panel rather than four loose buttons, in the look of the
// voice dock. Glyphs rather than words for the same reason the dock collapses
// to letters in a narrow roster: there is no room for "undeafen" here, and a
// struck-through mic says it in every language.

import type { ComponentChildren } from "preact";
import { voiceSession } from "../voice/session";
import { useVoiceSession } from "./VoiceDock";

// Stroked with currentColor at 18px, so they inherit the button's colour --
// and therefore the theme and the muted/off state -- with no per-theme rules.
// The slash is a child of the "off" variants rather than a separate overlay so
// it strokes and scales with the rest of the glyph.
function Glyph({ children, size = 18 }: { children: ComponentChildren; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const SLASH = <path d="M3 3l18 18" />;

// 131-6: the call rail uses the microphone and the headphones at its foot, at
// a smaller size, so both are exported.
export function IconMic({ off, size }: { off?: boolean; size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      {off && SLASH}
    </Glyph>
  );
}

export function IconHeadphones({ off, size }: { off?: boolean; size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="2" y="14" width="5" height="7" rx="2" />
      <rect x="17" y="14" width="5" height="7" rx="2" />
      {off && SLASH}
    </Glyph>
  );
}

export function IconCamera({ off, size }: { off?: boolean; size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 10l7-4v12l-7-4z" />
      {off && SLASH}
    </Glyph>
  );
}

export function IconScreen({ size }: { size?: number } = {}) {
  return (
    <Glyph size={size}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Glyph>
  );
}

// A toothed ring around the hub, not radiating spokes -- spokes read as a sun.
export function IconGear({ size }: { size?: number } = {}) {
  return (
    <Glyph size={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Glyph>
  );
}

// 131-7: leave. A handset put down, in the Glyph style of the others.
export function IconLeave({ size }: { size?: number } = {}) {
  return (
    <Glyph size={size}>
      <path d="M3 12.5c5.2-4.6 12.8-4.6 18 0l-2.4 2.9a1.4 1.4 0 0 1-1.9.3L14 14.2a8.6 8.6 0 0 0-4 0l-2.7 1.5a1.4 1.4 0 0 1-1.9-.3z" />
    </Glyph>
  );
}

// 131-7: the camera switch with its fallback, shared by this bar and the
// call rail. In a call that joined audio-only there is no camera track to
// flip, so the camera is asked for mid-call. A failure surfaces through the
// session error, which the call panel renders.
export function toggleCamOrEnable(): void {
  if (voiceSession.toggleCam()) return;
  void voiceSession.enableCamera();
}

interface Props {
  onOpenMicSettings: () => void;
  // 95-1: render nothing outside a call. The "always present" argument above
  // costs a 40px band across the bottom of a phone, which in Zuckermode is a
  // band the conversation list is paying for on every screen including the
  // ones with no voice in them. Set from App for the phone list; the panel
  // comes back the moment a room is joined, which is when the toggles have
  // something to act on. Pre-join defaults are still reachable -- settings ▸
  // voice.
  hideIdle?: boolean;
}

export function VoiceControls({ onOpenMicSettings, hideIdle }: Props) {
  const snap = useVoiceSession();
  const inCall = snap.phase === "in-call";
  // "joining" counts as joined here: the controls appear with the dock, not a
  // beat after it, or the footer would jump twice on the way into a room.
  if (hideIdle && snap.phase === "idle") return null;
  // Outside a call every title has to say that it is setting a default, or the
  // buttons read as broken -- pressing mute with nothing connected otherwise
  // looks like it did nothing.
  const suffix = (forNextRoom: string) => (inCall ? "" : ` — ${forNextRoom}`);

  return (
    <div
      class={"chalk-voice-controls" + (inCall ? "" : " is-idle")}
      data-testid="voice-controls"
    >
      <button
        class={"chalk-voice-ctlbtn" + (snap.muted ? " is-off" : "")}
        type="button"
        onClick={() => voiceSession.toggleMute()}
        title={
          snap.muted
            ? "unmute microphone" + suffix("you'll join rooms live")
            : "mute microphone" + suffix("you'll join rooms muted")
        }
        aria-pressed={snap.muted}
        aria-label={snap.muted ? "unmute microphone" : "mute microphone"}
        data-testid="voice-controls-mute"
      >
        <IconMic off={snap.muted} />
      </button>
      <button
        class={"chalk-voice-ctlbtn" + (snap.deafened ? " is-off" : "")}
        type="button"
        onClick={() => voiceSession.toggleDeafen()}
        title={
          snap.deafened
            ? "hear everyone again"
            : "deafen: silence everyone, and you" + suffix("you'll join rooms deafened")
        }
        aria-pressed={snap.deafened}
        aria-label={snap.deafened ? "hear everyone again" : "deafen everyone"}
        data-testid="voice-controls-deafen"
      >
        <IconHeadphones off={snap.deafened} />
      </button>
      <button
        class={"chalk-voice-ctlbtn" + (snap.camOn ? "" : " is-off")}
        type="button"
        onClick={toggleCamOrEnable}
        title={
          snap.camOn
            ? "turn the camera off" + suffix("you'll join rooms with video")
            : "turn the camera on" + suffix("you'll join rooms audio-only")
        }
        aria-pressed={snap.camOn}
        aria-label={snap.camOn ? "turn the camera off" : "turn the camera on"}
        data-testid="voice-controls-cam"
      >
        <IconCamera off={!snap.camOn} />
      </button>
      {/* Share is the one control here with no "default for the next room":
          the display picker needs a live call (and a user gesture), so outside
          one the button is disabled rather than pretending to set anything. */}
      <button
        class={"chalk-voice-ctlbtn" + (snap.sharing ? " is-on" : "")}
        type="button"
        disabled={!inCall}
        onClick={() => void voiceSession.toggleScreenShare()}
        title={
          !inCall
            ? "share a screen — join a voice room first"
            : snap.sharing
              ? "stop sharing your screen"
              : "share a screen, window, or tab"
        }
        aria-pressed={snap.sharing}
        aria-label={snap.sharing ? "stop sharing your screen" : "share your screen"}
        data-testid="voice-controls-share"
      >
        <IconScreen />
      </button>
      <button
        class="chalk-voice-ctlbtn"
        type="button"
        onClick={onOpenMicSettings}
        title="voice and video settings"
        aria-label="voice and video settings"
        data-testid="voice-controls-settings"
      >
        <IconGear />
      </button>
    </div>
  );
}
