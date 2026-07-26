// VoiceControls (44-2): the always-present mute / deafen / camera / mic-settings
// cluster, in the footer column under the roster.
//
// The point of it being always present is that all three toggles are GLOBAL
// (see voiceSession's setGlobal): outside a call they set the state the next
// room is joined in, inside a call they act on the live call as well. So you
// mute yourself before walking into the room, the way you would reach for the
// mute switch before putting the headset on -- rather than joining hot and
// scrambling for the dock's button.
//
// The labels follow the dock's CtlLabel idiom (a wide spelling and a single
// letter, CSS picks one) so the two rows of controls stacked above each other
// collapse together in a narrow roster column.

import { voiceSession } from "../voice/session";
import { useVoiceSession } from "./VoiceDock";

interface Props {
  onOpenMicSettings: () => void;
}

export function VoiceControls({ onOpenMicSettings }: Props) {
  const snap = useVoiceSession();
  const inCall = snap.phase === "in-call";

  const toggleCam = () => {
    if (voiceSession.toggleCam()) return;
    // In a call that joined audio-only there is no camera track to flip.
    // Acquiring one mid-call is the call panel's job (it has somewhere to
    // report a failure); from here, send the user there.
    void voiceSession.enableCamera();
  };

  return (
    <div class="chalk-voice-controls" data-testid="voice-controls">
      <button
        class={"chalk-btn chalk-voice-ctl" + (snap.muted ? " chalk-voice-ctl--off" : "")}
        type="button"
        onClick={() => voiceSession.toggleMute()}
        title={
          snap.muted
            ? inCall
              ? "unmute microphone"
              : "unmute — you'll join rooms with your mic live"
            : inCall
              ? "mute microphone"
              : "mute — you'll join rooms muted"
        }
        aria-pressed={snap.muted}
        aria-label={snap.muted ? "unmute microphone" : "mute microphone"}
        data-testid="voice-controls-mute"
      >
        <span class="chalk-voice-ctl-wide">{snap.muted ? "unmute" : "mute"}</span>
        <span class="chalk-voice-ctl-mini">m</span>
      </button>
      <button
        class={"chalk-btn chalk-voice-ctl" + (snap.deafened ? " chalk-voice-ctl--off" : "")}
        type="button"
        onClick={() => voiceSession.toggleDeafen()}
        title={
          snap.deafened
            ? "hear everyone again"
            : "deafen: silence everyone, and you"
        }
        aria-pressed={snap.deafened}
        aria-label={snap.deafened ? "hear everyone again" : "deafen everyone"}
        data-testid="voice-controls-deafen"
      >
        <span class="chalk-voice-ctl-wide">{snap.deafened ? "undeafen" : "deafen"}</span>
        <span class="chalk-voice-ctl-mini">d</span>
      </button>
      <button
        class={"chalk-btn chalk-voice-ctl" + (snap.camOn ? "" : " chalk-voice-ctl--off")}
        type="button"
        onClick={toggleCam}
        title={
          snap.camOn
            ? inCall
              ? "turn the camera off"
              : "camera off — you'll join rooms audio-only"
            : inCall
              ? "turn the camera on"
              : "camera on — you'll join rooms with video"
        }
        aria-pressed={snap.camOn}
        aria-label={snap.camOn ? "turn the camera off" : "turn the camera on"}
        data-testid="voice-controls-cam"
      >
        <span class="chalk-voice-ctl-wide">{snap.camOn ? "cam on" : "cam off"}</span>
        <span class="chalk-voice-ctl-mini">v</span>
      </button>
      <button
        class="chalk-btn chalk-voice-ctl"
        type="button"
        onClick={onOpenMicSettings}
        title="microphone and input settings"
        aria-label="microphone and input settings"
        data-testid="voice-controls-settings"
      >
        <span class="chalk-voice-ctl-wide">mic…</span>
        <span class="chalk-voice-ctl-mini">⚙</span>
      </button>
    </div>
  );
}
