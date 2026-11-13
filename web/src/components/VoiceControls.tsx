// VoiceControls.tsx: the glyphs of the call controls (microphone, headphones,
// camera, screen, gear, and leave) and toggleCamOrEnable. The call rail
// (CallRail.tsx), the phone call bar (PhoneCallBar.tsx), and the phone call
// view (PhoneCallSheet.tsx) import them. The file holds no component that
// draws a control panel.
//
// The mute, deafen, and camera toggles are GLOBAL (see voiceSession's
// setGlobal). Outside a call they set the state the next room is joined in.
// Inside a call they act on the live call as well. On desktop the pre-join
// defaults are in settings, voice.

import type { ComponentChildren } from "preact";
import { voiceSession } from "../voice/session";

// Stroked with currentColor at 18px by default, so they inherit the button's colour --
// and therefore the theme and the muted/off state -- with no per-theme rules.
// The slash is a child of the "off" variants rather than a separate overlay so
// it strokes and scales with the rest of the glyph. 131-12: with `filled`, the
// glyph is filled with currentColor and has no stroke.
function Glyph({
  children,
  size = 18,
  filled = false,
}: {
  children: ComponentChildren;
  size?: number;
  filled?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
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

// 131-6, 131-12: the call rail uses the microphone and the headphones at its
// foot, at 22px, so both are exported.
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

// 131-7, 131-12: leave. A filled handset put down.
export function IconLeave({ size }: { size?: number } = {}) {
  return (
    <Glyph size={size} filled>
      <path d="M2 13C5 9.7 8.4 8 12 8s7 1.7 10 5v.9l-2.3 2.3q-.5.5-1.1.1l-2.2-1.6q-.4-.3-.4-.8v-1.8c-2.6-.7-5.4-.7-8 0v1.8q0 .5-.4.8l-2.2 1.6q-.6.4-1.1-.1L2 13.9z" />
    </Glyph>
  );
}

// 131-7: the camera switch with its fallback, shared by the call rail, the
// phone call bar, and the phone call view. In a call that joined audio-only there is no camera track to
// flip, so the camera is asked for mid-call. A failure surfaces through the
// session error, which the call panel and the phone call view render.
export function toggleCamOrEnable(): void {
  if (voiceSession.toggleCam()) return;
  void voiceSession.enableCamera();
}
