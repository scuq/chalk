// VoiceControls (44-2): the always-present mute / deafen / camera / settings
// panel, in the footer column under the roster.
//
// The point of it being always present is that all three toggles are GLOBAL
// (see voiceSession's setGlobal): outside a call they set the state the next
// room is joined in, inside a call they act on the live call as well. So you
// mute yourself before walking into the room, the way you would reach for the
// mute switch before putting the headset on -- rather than joining hot and
// scrambling for the dock's button.
//
// 44-6: a bordered panel rather than four loose buttons, matching the voice
// dock that appears directly above it in the same column -- together they read
// as one voice block instead of stray letters in the corner. Glyphs rather
// than words for the same reason the dock collapses to letters in a narrow
// roster: there is no room for "undeafen" here, and a struck-through mic says
// it in every language.

import type { ComponentChildren } from "preact";
import { voiceSession } from "../voice/session";
import { useVoiceSession } from "./VoiceDock";

// Stroked with currentColor at 18px, so they inherit the button's colour --
// and therefore the theme and the muted/off state -- with no per-theme rules.
// The slash is a child of the "off" variants rather than a separate overlay so
// it strokes and scales with the rest of the glyph.
function Glyph({ children }: { children: ComponentChildren }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
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

function IconMic({ off }: { off?: boolean }) {
  return (
    <Glyph>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      {off && SLASH}
    </Glyph>
  );
}

function IconHeadphones({ off }: { off?: boolean }) {
  return (
    <Glyph>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="2" y="14" width="5" height="7" rx="2" />
      <rect x="17" y="14" width="5" height="7" rx="2" />
      {off && SLASH}
    </Glyph>
  );
}

function IconCamera({ off }: { off?: boolean }) {
  return (
    <Glyph>
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 10l7-4v12l-7-4z" />
      {off && SLASH}
    </Glyph>
  );
}

function IconGear() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </Glyph>
  );
}

interface Props {
  onOpenMicSettings: () => void;
}

export function VoiceControls({ onOpenMicSettings }: Props) {
  const snap = useVoiceSession();
  const inCall = snap.phase === "in-call";
  // Outside a call every title has to say that it is setting a default, or the
  // buttons read as broken -- pressing mute with nothing connected otherwise
  // looks like it did nothing.
  const suffix = (forNextRoom: string) => (inCall ? "" : ` — ${forNextRoom}`);

  const toggleCam = () => {
    if (voiceSession.toggleCam()) return;
    // In a call that joined audio-only there is no camera track to flip.
    // Acquiring one mid-call is the call panel's job (it has somewhere to
    // report a failure); from here, just ask for it.
    void voiceSession.enableCamera();
  };

  return (
    <div class="chalk-voice-controls" data-testid="voice-controls">
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
        onClick={toggleCam}
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
      <button
        class="chalk-voice-ctlbtn"
        type="button"
        onClick={onOpenMicSettings}
        title="microphone and input settings"
        aria-label="microphone and input settings"
        data-testid="voice-controls-settings"
      >
        <IconGear />
      </button>
    </div>
  );
}
