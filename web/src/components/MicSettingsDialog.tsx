// MicSettingsDialog (44-3): the voice and video settings, in a dialog of their own.
//
// They used to be a section three quarters of the way down the profile panel,
// which is the wrong place for the one setting you reach for mid-conversation
// ("nobody can hear me"). Opened from the ⚙ in the footer's voice cluster --
// beside the mute button, where you already are when something is wrong -- and
// still from the profile panel, for people who go looking there.
//
// Nothing but capture, playback and the devices they use lives here on purpose.
// The level meter needs the user watching it, and it cannot compete for
// attention with a theme picker.

import { useEffect } from "preact/hooks";
import { MicSettings } from "./MicSettings";
import type { VoicePrefs } from "../state/types";

interface Props {
  onClose: () => void;
  /** 66-1/66-5: the account-wide voice prefs (prefs.voice) and a patcher.
   * Everything else on this panel is per-machine and owns its own store. */
  voicePrefs: VoicePrefs;
  onVoicePrefsChange: (patch: Partial<VoicePrefs>) => void;
}

export function MicSettingsDialog({ onClose, voicePrefs, onVoicePrefsChange }: Props) {
  // Escape to close, like every other modal here. MicSettings' own key capture
  // stops propagation while rebinding, so this cannot steal that keystroke.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div class="chalk-modal-backdrop" onClick={onClose} data-testid="mic-settings-modal">
      <div
        class="chalk-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="mic-settings-title"
      >
        <header class="chalk-modal-header">
          <h2 id="mic-settings-title">voice &amp; video</h2>
          <button
            class="chalk-modal-close"
            type="button"
            onClick={onClose}
            aria-label="close"
            data-testid="mic-settings-close"
          >
            ×
          </button>
        </header>
        <div class="chalk-modal-body">
          <MicSettings voicePrefs={voicePrefs} onVoicePrefsChange={onVoicePrefsChange} />
        </div>
      </div>
    </div>
  );
}
