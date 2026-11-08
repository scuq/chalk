import type { ComponentChildren } from "preact";

// 133-13: the shared icon family. Every icon of the sidebar and of the channel
// header comes from this file, so all of them have one viewBox (24 by 24), one
// stroke width (2), round caps and joins, and the color of the text
// (currentColor). A hover or selected state in CSS recolors the icon with no
// extra rule. The voice-status badges and the call controls are not part of
// this family.

// The base of every icon. With a label, the icon is an image that a screen
// reader announces. Without a label, the icon is decoration and is hidden
// from a screen reader. The class chalk-icon sets display: block in theme.css.
function Icon({
  size,
  label,
  children,
}: {
  size: number;
  label?: string;
  children: ComponentChildren;
}) {
  return (
    <svg
      class="chalk-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      focusable={label ? undefined : "false"}
    >
      {children}
    </svg>
  );
}

// ChannelGlyph is the channel-kind icon of a sidebar row and of the channel
// header: a speech bubble for a text channel, a speaker with two waves for a
// voice channel. Both are 14px and carry a label for a screen reader.
export function ChannelGlyph({ type }: { type: "text" | "voice" }) {
  return type === "voice" ? <VoiceChannelIcon /> : <TextChannelIcon />;
}

function TextChannelIcon() {
  return (
    <Icon size={14} label="text channel">
      <path d="M5.5 4.5h13A2.5 2.5 0 0 1 21 7v9a2.5 2.5 0 0 1-2.5 2.5H10L5 22v-3.6A2.5 2.5 0 0 1 3 16V7a2.5 2.5 0 0 1 2.5-2.5Z" />
      <path d="M7 9h10M7 13h7" />
    </Icon>
  );
}

function VoiceChannelIcon() {
  return (
    <Icon size={14} label="voice channel">
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      <path d="M16 9a4 4 0 0 1 0 6" />
      <path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    </Icon>
  );
}

// ParkingIcon is the icon of the parking lot row: an eye with a line through
// it. A user can rename the row, so the icon alone must say that what is here
// is not shown. It is decoration and has no label.
export function ParkingIcon() {
  return (
    <Icon size={14}>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
      <line x1="3" y1="21" x2="21" y2="3" />
    </Icon>
  );
}

// LockIcon is the padlock of the encryption indicator, 12px. The shackle is
// closed when the channel key is ready and open when the key is pending. The
// open shackle never means plaintext: the indicator fails closed.
export function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <Icon size={12}>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d={open ? "M8 10V8a4 4 0 0 1 7.46-2" : "M8 10V8a4 4 0 0 1 8 0v2"} />
    </Icon>
  );
}

// CrownIcon is the governance badge of a channel in dictator mode: the owner
// acts alone.
export function CrownIcon() {
  return (
    <Icon size={14}>
      <path d="M3 7.5 7.5 12 12 5 16.5 12 21 7.5 19 19H5Z" />
      <path d="M5.5 16h13" />
    </Icon>
  );
}

// BallotIcon is the governance badge of a channel in democratic mode: a ballot
// box. A member vote decides the privileged actions.
export function BallotIcon() {
  return (
    <Icon size={14}>
      <path d="M3 12v8h18v-8" />
      <path d="M2 8l10-4 10 4-10 4Z" />
      <path d="M12 12v4" />
    </Icon>
  );
}
