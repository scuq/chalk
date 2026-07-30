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
//
// 44-8: the two VAD thresholds ARE handles on that meter now, rather than a
// pair of sliders somewhere below it. Both halves of the old arrangement were
// wrong: a threshold is only meaningful against the level it is compared to, so
// setting it on a separate track meant reading a percentage off one control and
// guessing where that fell on another -- and the meter's linear scale had the
// whole useful range squeezed into its left tenth (see meter-scale.ts).

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { MAX_GAIN, MAX_HOLD_MS, MIN_GAIN, useMicPrefs, type MicPrefs } from "../voice/mic-prefs";
import { MicChain } from "../voice/mic-chain";
import { describeMediaError } from "../voice/call";
import { voiceSession } from "../voice/session";
import { TRANSMIT_LABELS, TRANSMIT_MODES, isTransmitMode } from "../voice/vad";
import { isTypingTarget, keyLabel } from "../voice/hotkeys";
import { METER_FLOOR_DB, dbLabel, meterPos, meterRms, rmsToDb } from "../voice/meter-scale";
import {
  canChooseOutput,
  useDevicePrefs,
  useMediaDevices,
  type DevicePrefs,
} from "../voice/device-prefs";
import { CameraChain } from "../voice/camera-chain";
import { applyBlurTo } from "../voice/camera-blur";
import { previewSource } from "../voice/camera-effects";

// Above this the signal is too hot to leave alone: clipping is unrecoverable at
// the far end, where a quiet signal is merely quiet. The bar turns red here.
//
// -6 dBFS, not the 0.95 RMS this used to compare against -- a full-scale sine
// is only 0.707 RMS, so the old warning could not fire for any real signal.
const HOT_LEVEL = 0.5;

// One arrow key of threshold, as a fraction of the meter's travel. 1% of 60 dB
// is 0.6 dB, which is about the smallest step worth having.
const KEY_STEP = 0.01;
const KEY_STEP_COARSE = 0.05;

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

/**
 * ThresholdHandle: one of the two VAD marks, dragged along the meter it is
 * compared against.
 *
 * Pointer capture, so a drag that wanders off a 16px-tall track keeps tracking
 * instead of stopping dead. Focusable with arrow keys, because the last decibel
 * of a threshold is easier to type than to drag -- and because a control with
 * no keyboard path is not a control for everyone.
 */
function ThresholdHandle({
  kind,
  label,
  value,
  onMove,
  posFromClientX,
  testId,
}: {
  kind: "open" | "close";
  label: string;
  value: number;
  onMove: (rms: number) => void;
  posFromClientX: (clientX: number) => number;
  testId: string;
}) {
  const dragging = useRef(false);

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? KEY_STEP_COARSE : KEY_STEP;
    let pos = meterPos(value);
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        pos -= step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        pos += step;
        break;
      case "Home":
        pos = 0;
        break;
      case "End":
        pos = 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    onMove(meterRms(pos));
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      class={`chalk-profile-mic-mark chalk-profile-mic-mark--${kind}`}
      style={{ left: `${meterPos(value) * 100}%` }}
      aria-label={label}
      aria-valuemin={METER_FLOOR_DB}
      aria-valuemax={0}
      aria-valuenow={Math.round(rmsToDb(value))}
      aria-valuetext={dbLabel(value)}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        // preventDefault stops the browser starting a text selection across the
        // panel, but it also suppresses the focus that would follow, so take it
        // by hand -- otherwise arrow keys do nothing until you tab back in.
        e.preventDefault();
        (e.currentTarget as HTMLElement).focus();
      }}
      onPointerMove={(e) => {
        if (dragging.current) onMove(meterRms(posFromClientX(e.clientX)));
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      data-testid={testId}
    />
  );
}

/**
 * MicMeter owns the preview capture and the level it draws.
 *
 * A component of its own because the level updates every animation frame, and
 * inside MicSettings that re-rendered the device list, four sliders and three
 * keybind buttons sixty times a second -- which is what made dragging anything
 * in this panel feel like it was catching. Here the 60 Hz redraw is a bar and
 * two handles.
 */
function MicMeter({
  mic,
  setMic,
}: {
  mic: MicPrefs;
  setMic: (patch: Partial<MicPrefs>) => void;
}) {
  const [metering, setMetering] = useState(false);
  const [level, setLevel] = useState(0);
  const [transmitting, setTransmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The preview capture, open only while metering outside a call. Held in a
  // ref, not state: the rAF loop and the cleanup both need the current value
  // without re-running on every change.
  const preview = useRef<MicChain | null>(null);
  const track = useRef<HTMLDivElement | null>(null);

  /** Where a pointer landed, as a 0..1 fraction of the meter's width. */
  const posFromClientX = useCallback((clientX: number): number => {
    const el = track.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? (clientX - r.left) / r.width : 0;
  }, []);

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

  const hot = level >= HOT_LEVEL;

  return (
    <div class="chalk-profile-field">
      <div class="chalk-profile-mic-test">
        <div class="chalk-profile-mic-meter" ref={track} data-testid="mic-meter">
          <div
            class="chalk-profile-mic-meter-bar"
            role="meter"
            aria-label="microphone level"
            aria-valuenow={Math.round(rmsToDb(level))}
            aria-valuemin={METER_FLOOR_DB}
            aria-valuemax={0}
            aria-valuetext={dbLabel(level)}
          >
            <div
              class={`chalk-profile-mic-meter-fill${hot ? " is-clipping" : ""}`}
              style={{ width: `${meterPos(level) * 100}%` }}
            />
          </div>
          {/* The thresholds sit ON the meter, because that is the only place
              either number means anything: you watch where your voice lands and
              drag the marks around it. */}
          {mic.mode === "vad" && (
            <>
              <ThresholdHandle
                kind="close"
                label="silence below"
                value={mic.vadClose}
                onMove={(v) => setMic({ vadClose: v })}
                posFromClientX={posFromClientX}
                testId="mic-vad-close"
              />
              <ThresholdHandle
                kind="open"
                label="speech above"
                value={mic.vadOpen}
                onMove={(v) => setMic({ vadOpen: v })}
                posFromClientX={posFromClientX}
                testId="mic-vad-open"
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
      {mic.mode === "vad" && (
        <div class="chalk-profile-mic-thresholds">
          <span>
            speech above <span class="chalk-profile-theme-desc">({dbLabel(mic.vadOpen)})</span>
          </span>
          <span>
            silence below <span class="chalk-profile-theme-desc">({dbLabel(mic.vadClose)})</span>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * DeviceSelect: one "which of these do I use" dropdown.
 *
 * 44-9: hidden when the machine has nothing to choose between, unless a device
 * is already picked -- a stale choice for a webcam that has since been unplugged
 * has to stay reachable, or there is no way to take it back.
 */
function DeviceSelect({
  id,
  label,
  fallbackName,
  devices,
  value,
  onChange,
  testId,
  alwaysShow,
}: {
  id: string;
  label: string;
  fallbackName: string;
  devices: MediaDeviceInfo[];
  value: string;
  onChange: (deviceId: string) => void;
  testId: string;
  alwaysShow?: boolean;
}) {
  if (!alwaysShow && devices.length < 2 && !value) return null;
  return (
    <div class="chalk-profile-field">
      <label class="chalk-profile-label" for={id}>
        {label}
      </label>
      <select
        id={id}
        class="chalk-profile-select"
        value={value}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
        data-testid={testId}
      >
        <option value="">system default</option>
        {devices.map((d, i) => (
          <option value={d.deviceId} key={d.deviceId}>
            {d.label || `${fallbackName} ${i + 1}`}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * CameraPreview (52-4): what your camera is about to send, before you send it.
 *
 * Without this the blur toggle is a promise you cannot check -- it does nothing
 * visible until you are in a call with your camera on, which is the worst
 * moment to discover that your room is still legible or that the effect is too
 * slow for this machine.
 *
 * ON DEMAND, never automatic. Opening the camera because someone opened the
 * settings dialog would light their camera indicator for a setting they came
 * to change about the microphone.
 *
 * It runs the REAL pipeline -- the same CameraChain and the same applyBlurTo as
 * a call -- so what it shows is what peers would get, including the cadence
 * backing off on a slow machine. A mock would be a picture of a feature rather
 * than the feature.
 */
function CameraPreview({ dev }: { dev: DevicePrefs }) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  // The chain is ours only when we opened it; when the preview is showing the
  // call's own picture there is nothing here to close.
  const chain = useRef<CameraChain | null>(null);

  // The call's published video, or null when it has none. Tracked rather than
  // read once: turning the camera on or off in the call while this is open
  // changes which source is the right one, and being a dependency below means
  // the switch happens by re-running the one start path instead of a second.
  const [callVideo, setCallVideo] = useState<MediaStream | null>(() => {
    const s = voiceSession.snap();
    return previewSource(s) === "call" ? s.localStream : null;
  });
  useEffect(
    () =>
      voiceSession.subscribe(() => {
        const s = voiceSession.snap();
        setCallVideo(previewSource(s) === "call" ? s.localStream : null);
      }),
    [],
  );

  useEffect(() => {
    if (!on) return;
    let stopped = false;

    const start = async () => {
      if (callVideo) {
        setStream(callVideo);
        return;
      }
      try {
        const opened = await CameraChain.open(dev);
        if (stopped) {
          opened.close();
          return;
        }
        chain.current = opened;
        setStream(new MediaStream([opened.track]));
        setError(null);
        await applyBlurTo(opened, dev.backgroundBlur, {
          stillWanted: () => !stopped,
          onGiveUp: () => {
            if (!stopped) setError("blur is too slow on this machine — it turned itself off");
          },
        });
      } catch (err) {
        if (stopped) return;
        setError(describeMediaError("camera", err));
        setOn(false);
      }
    };
    void start();

    return () => {
      stopped = true;
      const opened = chain.current;
      chain.current = null;
      opened?.close();
      setStream(null);
    };
    // dev is read once to open the capture; later changes are pushed into the
    // live chain by the two effects below rather than by reopening it. The
    // cleanup closing our chain when callVideo appears is deliberate: the call
    // taking its camera up means our second capture of the same device should
    // go away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, callVideo]);

  // Toggling blur while the preview is up applies to it immediately -- that is
  // the whole point of having it open while you decide.
  useEffect(() => {
    const opened = chain.current;
    if (!opened) return;
    applyBlurTo(opened, dev.backgroundBlur, {
      stillWanted: () => chain.current === opened,
      onGiveUp: () => setError("blur is too slow on this machine — it turned itself off"),
    }).catch(() => setError("couldn't start background blur"));
  }, [dev.backgroundBlur]);

  // The device is a property of the capture, so the preview has to re-acquire.
  useEffect(() => {
    chain.current?.recapture(dev).catch((err) => setError(describeMediaError("camera", err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev.cameraId]);

  return (
    <div class="chalk-profile-field">
      <div class="chalk-profile-camera-preview">
        {stream && <PreviewSurface stream={stream} />}
        <button
          type="button"
          class="chalk-profile-camera-btn"
          onClick={() => {
            setError(null);
            setOn((v) => !v);
          }}
          aria-label={on ? "stop the camera preview" : "preview the camera"}
          data-testid="camera-preview-toggle"
        >
          {on ? "stop preview" : "preview"}
        </button>
      </div>
      {error && (
        <p class="chalk-profile-hint" data-testid="camera-preview-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Mirrored, like every other self-view in the app: an un-mirrored preview of
 *  your own face reads as someone else's camera. */
function PreviewSurface({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      class="chalk-voice-video chalk-voice-video-mirrored chalk-profile-camera-video"
      data-testid="camera-preview-video"
      autoPlay
      playsInline
      muted
    />
  );
}

export function MicSettings() {
  const [mic, setMic] = useMicPrefs();
  const [dev, setDev] = useDevicePrefs();
  const devices = useMediaDevices();

  // Labels are empty until mic permission has been granted at least once, so
  // an un-permitted browser shows a list of anonymous "microphone 2" entries.
  // Pressing test grants it, which is why the hint points there.
  const unlabeled =
    devices.audioinput.length > 0 && devices.audioinput.every((d) => !d.label);

  return (
    <section class="chalk-profile-microphone" data-testid="mic-settings">
      <DeviceSelect
        id="mic-device"
        label="input device"
        fallbackName="microphone"
        devices={devices.audioinput}
        value={mic.deviceId}
        onChange={(deviceId) => setMic({ deviceId })}
        testId="mic-device"
        // The one picker that shows even with a single microphone: it is the
        // first thing anyone looks for when nobody can hear them, and a browser
        // that has not been given permission yet reports one anonymous entry.
        alwaysShow
      />

      <DeviceSelect
        id="camera-device"
        label="camera"
        fallbackName="camera"
        devices={devices.videoinput}
        value={dev.cameraId}
        onChange={(cameraId) => setDev({ cameraId })}
        testId="camera-device"
      />

      {/* 52-1: sits under the camera picker because it is a property of the
          picture, not of the call. Per-machine, like the camera itself. */}
      <div class="chalk-profile-field">
        <label class="chalk-profile-checkbox-label">
          <input
            type="checkbox"
            checked={dev.backgroundBlur}
            onChange={(e) =>
              setDev({ backgroundBlur: (e.target as HTMLInputElement).checked })
            }
            data-testid="camera-background-blur"
          />
          <span>
            blur my background{" "}
            <span class="chalk-profile-theme-desc">
              (hides the room behind you while your camera is on. takes effect
              immediately, mid-call and all)
            </span>
          </span>
        </label>
      </div>

      <CameraPreview dev={dev} />

      {/* Firefox does not list output devices and Safari cannot route to one,
          so on those this is absent rather than a control that does nothing. */}
      {canChooseOutput() && (
        <DeviceSelect
          id="output-device"
          label="output device"
          fallbackName="speakers"
          devices={devices.audiooutput}
          value={dev.outputId}
          onChange={(outputId) => setDev({ outputId })}
          testId="output-device"
        />
      )}

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
          // onInput, so the meter moves under your finger rather than jumping
          // when you let go. It used to be onChange because every pixel of the
          // drag was a write plus a fan-out to the other tabs and the server;
          // 44-8 coalesces the upload in mic-prefs, so live tracking is cheap.
          onInput={(e) => setMic({ gain: Number((e.target as HTMLInputElement).value) })}
          data-testid="mic-gain"
        />
      </div>

      <MicMeter mic={mic} setMic={setMic} />

      {/* 44-7: a dropdown, not four stacked cards. The four modes are mutually
          exclusive one-liners, and as cards they took more of the dialog than
          the level meter -- which is the thing you actually came here to
          watch. The chosen mode's explanation sits under the select, so
          nothing is lost by collapsing them. */}
      <div class="chalk-profile-field">
        <label class="chalk-profile-label" for="mic-mode">
          when to transmit
        </label>
        <select
          id="mic-mode"
          class="chalk-profile-select"
          value={mic.mode}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (isTransmitMode(v)) setMic({ mode: v });
          }}
          data-testid="mic-mode"
        >
          {TRANSMIT_MODES.map((m) => (
            <option value={m} key={m}>
              {TRANSMIT_LABELS[m].label}
            </option>
          ))}
        </select>
        <p class="chalk-profile-hint">{TRANSMIT_LABELS[mic.mode].desc}</p>
      </div>

      {mic.mode === "vad" && (
        <p class="chalk-profile-hint">
          press test and talk normally, then drag the two marks on the meter above: the bright one
          just under where your voice sits, the dim one just over where the quiet room sits. the gap
          between them is what stops the mic flickering on a pause. arrow keys nudge a mark once it
          has focus.
        </p>
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
            onInput={(e) => setMic({ holdMs: Number((e.target as HTMLInputElement).value) })}
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
              (your browser's — it learns steady sounds like fans and hum, so it barely touches
              keyboards and door slams. for those, use "when i speak" above)
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
              (off by default: it fills your pauses by winding the mic up until the room is as loud
              as you were, and it moves the floor the marks above are set against)
            </span>
          </span>
        </label>
      </div>

      <p class="chalk-profile-hint">
        {unlabeled ? "press test once to let the browser name your devices. " : ""}
        everything here except the three device pickers follows your account, so a second machine
        starts where this one left off — the devices stay here, since they name sockets on this
        computer. changes apply to a call you're already in — no need to rejoin.
      </p>
    </section>
  );
}
