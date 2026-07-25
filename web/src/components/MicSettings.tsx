// MicSettings (41-3): the microphone section of the profile panel.
//
// Per-device, like the notification sounds above it, so this talks to
// localStorage through useMicPrefs directly rather than taking props --
// nothing here goes near the server.
//
// The level meter is the point of the section. A gain slider with no feedback
// is a guess; with a meter you drag until you are speaking in the top half and
// not clipping, which is the whole of mic setup for most people. It reads
// POST-gain, so the bar responds to the slider as you move it.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { MAX_GAIN, MIN_GAIN, useMicPrefs } from "../voice/mic-prefs";
import { MicChain } from "../voice/mic-chain";
import { describeMediaError } from "../voice/call";
import { voiceSession } from "../voice/session";

// Above this the signal is about to clip, and clipping is unrecoverable at the
// far end where a quiet signal is merely quiet. The bar turns red here.
const CLIP_LEVEL = 0.95;

export function MicSettings() {
  const [mic, setMic] = useMicPrefs();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [metering, setMetering] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The preview capture, open only while metering outside a call. Held in a
  // ref, not state: the rAF loop and the cleanup both need the current value
  // without re-running on every change.
  const preview = useRef<MicChain | null>(null);

  // Labels are empty until mic permission has been granted at least once, so
  // an un-permitted browser shows a list of anonymous "microphone 2" entries.
  // Pressing test grants it, which is why the hint points there.
  const unlabeled = devices.length > 0 && devices.every((d) => !d.label);

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "audioinput"));
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    if (!navigator.mediaDevices) return;
    void refreshDevices();
    // Plugging a headset in while this panel is open should just work.
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  // Metering. A live call is already capturing, so meter THAT rather than
  // opening a second capture of the same device -- two captures of one mic
  // means two AGCs fighting, and a meter that disagrees with what is being
  // sent. Outside a call we open our own short-lived chain.
  useEffect(() => {
    if (!metering) return;
    let raf = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      setLevel(preview.current ? preview.current.level() : (voiceSession.micLevel() ?? 0));
      raf = requestAnimationFrame(tick);
    };

    const start = async () => {
      if (voiceSession.micLevel() === null) {
        try {
          const chain = await MicChain.open({ ...mic });
          if (stopped) {
            void chain.close();
            return;
          }
          preview.current = chain;
        } catch (err) {
          if (!stopped) {
            setError(describeMediaError("microphone", err));
            setMetering(false);
          }
          return;
        }
      }
      setError(null);
      tick();
    };
    void start();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      const chain = preview.current;
      preview.current = null;
      void chain?.close();
      setLevel(0);
    };
    // mic is read once at start to open the capture; later changes are pushed
    // through setGain / recapture below rather than by restarting the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metering]);

  // Push a gain change into the preview immediately, so the bar tracks the
  // slider under the user's finger. A live call gets the same change through
  // voiceSession's own subscription (41-4).
  useEffect(() => {
    preview.current?.setGain(mic.gain);
  }, [mic.gain]);

  // The device and the processing flags are properties of the capture, so the
  // preview has to re-acquire to reflect them.
  useEffect(() => {
    const chain = preview.current;
    if (!chain) return;
    chain.recapture({ ...mic }).catch((err) => {
      setError(describeMediaError("microphone", err));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic.deviceId, mic.echoCancellation, mic.noiseSuppression, mic.autoGainControl]);

  const clipping = level >= CLIP_LEVEL;

  return (
    <section class="chalk-profile-microphone" data-testid="mic-settings">
      <h3>microphone</h3>

      <div class="chalk-profile-field">
        <label class="chalk-profile-label" for="mic-device">
          input device
        </label>
        <select
          id="mic-device"
          class="chalk-profile-select"
          value={mic.deviceId}
          onChange={(e) => setMic({ deviceId: (e.target as HTMLSelectElement).value })}
          data-testid="mic-device"
        >
          <option value="">system default</option>
          {devices.map((d, i) => (
            <option value={d.deviceId} key={d.deviceId}>
              {d.label || `microphone ${i + 1}`}
            </option>
          ))}
        </select>
      </div>

      <div class="chalk-profile-field">
        <label class="chalk-profile-label" for="mic-gain">
          input volume{" "}
          <span class="chalk-profile-theme-desc">({Math.round(mic.gain * 100)}%)</span>
        </label>
        <input
          id="mic-gain"
          type="range"
          class="chalk-profile-range"
          min={MIN_GAIN}
          max={MAX_GAIN}
          step={0.05}
          value={mic.gain}
          // onChange, not onInput: a range fires input on every pixel of the
          // drag, and each one is a write plus a fan-out to the other tabs.
          onChange={(e) => setMic({ gain: Number((e.target as HTMLInputElement).value) })}
          data-testid="mic-gain"
        />
      </div>

      <div class="chalk-profile-field">
        <div class="chalk-profile-mic-test">
          <div
            class="chalk-profile-mic-meter"
            role="meter"
            aria-label="microphone level"
            aria-valuenow={Math.round(level * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            data-testid="mic-meter"
          >
            <div
              class={`chalk-profile-mic-meter-fill${clipping ? " is-clipping" : ""}`}
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>
          <button
            type="button"
            class="chalk-profile-sound-preview"
            onClick={() => setMetering((on) => !on)}
            aria-label={metering ? "stop metering the microphone" : "test the microphone"}
            data-testid="mic-test"
          >
            {metering ? "stop" : "test"}
          </button>
        </div>
        {error && (
          <p class="chalk-profile-hint" data-testid="mic-error">
            {error}
          </p>
        )}
      </div>

      <div class="chalk-profile-field">
        <label class="chalk-profile-checkbox-label">
          <input
            type="checkbox"
            checked={mic.echoCancellation}
            onChange={(e) => setMic({ echoCancellation: (e.target as HTMLInputElement).checked })}
            data-testid="mic-echo-cancellation"
          />
          <span>
            echo cancellation{" "}
            <span class="chalk-profile-theme-desc">
              (stops others hearing themselves back — leave on unless you wear headphones)
            </span>
          </span>
        </label>
      </div>

      <div class="chalk-profile-field">
        <label class="chalk-profile-checkbox-label">
          <input
            type="checkbox"
            checked={mic.noiseSuppression}
            onChange={(e) => setMic({ noiseSuppression: (e.target as HTMLInputElement).checked })}
            data-testid="mic-noise-suppression"
          />
          <span>
            noise suppression{" "}
            <span class="chalk-profile-theme-desc">
              (your browser's — good on fans and hum, weaker on keyboards)
            </span>
          </span>
        </label>
      </div>

      <div class="chalk-profile-field">
        <label class="chalk-profile-checkbox-label">
          <input
            type="checkbox"
            checked={mic.autoGainControl}
            onChange={(e) => setMic({ autoGainControl: (e.target as HTMLInputElement).checked })}
            data-testid="mic-auto-gain"
          />
          <span>
            automatic gain control{" "}
            <span class="chalk-profile-theme-desc">
              (the browser rides the level for you — turn it off to set input volume by hand)
            </span>
          </span>
        </label>
      </div>

      <p class="chalk-profile-hint">
        {unlabeled
          ? "press test once to let the browser name your microphones. "
          : ""}
        these settings stay on this device. changes apply to a call you're already in — no need to
        rejoin.
      </p>
    </section>
  );
}
