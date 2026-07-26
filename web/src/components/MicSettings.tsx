// MicSettings (41-3): the body of the microphone settings dialog.
//
// It talks to useMicPrefs directly rather than taking props -- see mic-prefs.ts
// for what that persists where (44-4: tuning and keybinds follow the account,
// the chosen input device stays on this machine).
//
// The level meter is the point of the panel. A gain slider with no feedback
// is a guess; with a meter you drag until you are speaking in the top half and
// not clipping, which is the whole of mic setup for most people. It reads
// POST-gain, so the bar responds to the slider as you move it.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { MAX_GAIN, MAX_HOLD_MS, MIN_GAIN, useMicPrefs } from "../voice/mic-prefs";
import { MicChain } from "../voice/mic-chain";
import { describeMediaError } from "../voice/call";
import { voiceSession } from "../voice/session";
import { TRANSMIT_LABELS, TRANSMIT_MODES } from "../voice/vad";
import { isTypingTarget, keyLabel } from "../voice/hotkeys";

// Above this the signal is about to clip, and clipping is unrecoverable at the
// far end where a quiet signal is merely quiet. The bar turns red here.
const CLIP_LEVEL = 0.95;

/**
 * KeyBind: click, then press the key you want. Captures on the way DOWN the
 * tree so the global voice hotkeys don't also act on the keystroke -- otherwise
 * rebinding your mute key would mute you.
 */
function KeyBind({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (code: string) => void;
  testId: string;
}) {
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setCapturing(false);
      // Escape backs out; backspace/delete unbinds. Neither is a plausible
      // voice key, and without them there is no way to undo a bind.
      if (e.code === "Escape") return;
      onChange(e.code === "Backspace" || e.code === "Delete" ? "" : e.code);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, onChange]);

  return (
    <div class="chalk-profile-sound-row">
      <span>{label}</span>
      <button
        type="button"
        class={`chalk-profile-sound-preview${capturing ? " is-capturing" : ""}`}
        onClick={() => setCapturing((c) => !c)}
        aria-label={`${label}: ${capturing ? "press a key" : keyLabel(value)}`}
        data-testid={testId}
      >
        {capturing ? "press a key…" : keyLabel(value)}
      </button>
    </div>
  );
}

export function MicSettings() {
  const [mic, setMic] = useMicPrefs();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [metering, setMetering] = useState(false);
  const [level, setLevel] = useState(0);
  const [transmitting, setTransmitting] = useState(false);
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
      const chain = preview.current;
      setLevel(chain ? chain.level() : (voiceSession.micLevel() ?? 0));
      setTransmitting(chain ? chain.transmitting : voiceSession.snap().micOpen);
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

  // Push gain and gate changes into the preview immediately, so the bar tracks
  // the slider under the user's finger. A live call gets the same change
  // through voiceSession's own subscription (41-4).
  useEffect(() => {
    preview.current?.setPrefs(mic);
  }, [mic.gain, mic.mode, mic.vadOpen, mic.vadClose, mic.holdMs]);

  // The global keybinds route the hold key to the live CALL, which does not
  // exist while someone is only testing. Without this, pressing test in
  // push-to-talk mode would show "silent" no matter what key you held -- the
  // two modes that most need testing would be the two you cannot test.
  useEffect(() => {
    if (!metering || !mic.keyTalk) return;
    if (mic.mode !== "ptt" && mic.mode !== "ptm") return;
    const down = (e: KeyboardEvent) => {
      if (e.code === mic.keyTalk && !isTypingTarget(e.target)) preview.current?.setKeyHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === mic.keyTalk) preview.current?.setKeyHeld(false);
    };
    const release = () => preview.current?.setKeyHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      release();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, [metering, mic.mode, mic.keyTalk]);

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
            {/* The thresholds sit ON the meter, because that is the only way
                either number means anything: you watch where your voice lands
                and put the marks around it. */}
            {mic.mode === "vad" && (
              <>
                <span
                  class="chalk-profile-mic-mark chalk-profile-mic-mark--close"
                  style={{ left: `${mic.vadClose * 100}%` }}
                />
                <span
                  class="chalk-profile-mic-mark chalk-profile-mic-mark--open"
                  style={{ left: `${mic.vadOpen * 100}%` }}
                />
              </>
            )}
          </div>
          {metering && (
            <span
              class={`chalk-profile-mic-live${transmitting ? " is-live" : ""}`}
              data-testid="mic-live"
            >
              {transmitting ? "sending" : "silent"}
            </span>
          )}
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
        <label class="chalk-profile-label">when to transmit</label>
        <div class="chalk-profile-theme-picker" role="radiogroup" aria-label="transmit mode">
          {TRANSMIT_MODES.map((m) => (
            <label
              class={`chalk-profile-theme-option${mic.mode === m ? " is-active" : ""}`}
              key={m}
            >
              <input
                type="radio"
                name="mic-mode"
                value={m}
                checked={mic.mode === m}
                onChange={() => setMic({ mode: m })}
                data-testid={`mic-mode-${m}`}
              />
              <span class="chalk-profile-theme-name">{TRANSMIT_LABELS[m].label}</span>
              <span class="chalk-profile-theme-desc">{TRANSMIT_LABELS[m].desc}</span>
            </label>
          ))}
        </div>
      </div>

      {mic.mode === "vad" && (
        <div class="chalk-profile-field">
          <label class="chalk-profile-label" for="mic-vad-open">
            speech above{" "}
            <span class="chalk-profile-theme-desc">
              ({Math.round(mic.vadOpen * 100)}% — over this, the mic opens)
            </span>
          </label>
          <input
            id="mic-vad-open"
            type="range"
            class="chalk-profile-range"
            min={0}
            max={1}
            step={0.01}
            value={mic.vadOpen}
            onChange={(e) => setMic({ vadOpen: Number((e.target as HTMLInputElement).value) })}
            data-testid="mic-vad-open"
          />
          <label class="chalk-profile-label" for="mic-vad-close">
            silence below{" "}
            <span class="chalk-profile-theme-desc">
              ({Math.round(mic.vadClose * 100)}% — under this, it closes again)
            </span>
          </label>
          <input
            id="mic-vad-close"
            type="range"
            class="chalk-profile-range"
            min={0}
            max={1}
            step={0.01}
            value={mic.vadClose}
            onChange={(e) => setMic({ vadClose: Number((e.target as HTMLInputElement).value) })}
            data-testid="mic-vad-close"
          />
          <p class="chalk-profile-hint">
            press test and talk normally. put "speech above" just under where your voice sits, and
            "silence below" just over where the room sits. the gap between them is what stops the
            mic flickering on a pause.
          </p>
        </div>
      )}

      {(mic.mode === "vad" || mic.mode === "ptt") && (
        <div class="chalk-profile-field">
          <label class="chalk-profile-label" for="mic-hold">
            keep sending for{" "}
            <span class="chalk-profile-theme-desc">
              ({Math.round(mic.holdMs)} ms after you stop)
            </span>
          </label>
          <input
            id="mic-hold"
            type="range"
            class="chalk-profile-range"
            min={0}
            max={MAX_HOLD_MS}
            step={50}
            value={mic.holdMs}
            onChange={(e) => setMic({ holdMs: Number((e.target as HTMLInputElement).value) })}
            data-testid="mic-hold"
          />
        </div>
      )}

      <div class="chalk-profile-field">
        <label class="chalk-profile-label">keys</label>
        <div class="chalk-profile-sound-list">
          {(mic.mode === "ptt" || mic.mode === "ptm") && (
            <KeyBind
              label={mic.mode === "ptt" ? "hold to talk" : "hold to mute"}
              value={mic.keyTalk}
              onChange={(code) => setMic({ keyTalk: code })}
              testId="mic-key-talk"
            />
          )}
          <KeyBind
            label="mute / unmute"
            value={mic.keyMute}
            onChange={(code) => setMic({ keyMute: code })}
            testId="mic-key-mute"
          />
          <KeyBind
            label="deafen"
            value={mic.keyDeafen}
            onChange={(code) => setMic({ keyDeafen: code })}
            testId="mic-key-deafen"
          />
        </div>
        <p class="chalk-profile-hint">
          keys only work while a chalk tab is in front — a web page can't take a key from the rest
          of your system, so push to talk won't reach you inside a fullscreen game.
        </p>
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
        everything here except the input device follows your account, so a second machine starts
        where this one left off — the device stays here, since it names a socket on this computer.
        changes apply to a call you're already in — no need to rejoin.
      </p>
    </section>
  );
}
