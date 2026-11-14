import type { ComponentChildren } from "preact";

// 133-13: the shared icon family. Every icon of the sidebar, of the channel
// header, and (133-14) of the composer tools and send comes from this file.
// All of them have one viewBox (24 by 24), round caps and joins, and the color
// of the text (currentColor). The stroke is 2, or 1.8 with the fine prop,
// which the composer icons use. A hover or selected state in CSS recolors the
// icon with no extra rule. The voice-status badges and the call controls are
// not part of this family. The phone list section rows (137-4) and the
// buttons of the phone list head (137-10) also draw from it.

// The base of every icon. With a label, the icon is an image that a screen
// reader announces. Without a label, the icon is decoration and is hidden
// from a screen reader. The class chalk-icon sets display: block in theme.css.
function Icon({
  size,
  label,
  fine = false,
  children,
}: {
  size: number;
  label?: string;
  fine?: boolean;
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
      stroke-width={fine ? "1.8" : "2"}
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

// ParkingIcon is the icon of the parking lot: an eye with a line through it.
// A user can rename the parking lot, so the icon alone must say that what is
// here is not shown. It is decoration and has no label. The size is 14px by
// default, as in the desktop sidebar. Above 14px it uses the fine stroke
// (137-10, the phone list head uses 18px).
export function ParkingIcon({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size} fine={size > 14}>
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

// 133-14: the composer tool icons and the send icon use the fine stroke (1.8)
// that the external design review asked for. The tool icons are 17px. The
// buttons carry the aria-label, so the icons are decoration.
export function AttachIcon() {
  return (
    <Icon size={17} fine>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Icon>
  );
}

// GifIcon is a framed play triangle. It reads as "animated image", not as
// "video".
export function GifIcon() {
  return (
    <Icon size={17} fine>
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="M10 9.2l5.2 2.8-5.2 2.8z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function EmojiIcon() {
  return (
    <Icon size={17} fine>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5h.01" />
      <path d="M15 9.5h.01" />
    </Icon>
  );
}

// 74-2: CodeIcon is two angle brackets with no slash. At this size a third
// stroke turns the glyph into a smudge.
export function CodeIcon() {
  return (
    <Icon size={17} fine>
      <path d="M8 6l-6 6 6 6" />
      <path d="M16 6l6 6-6 6" />
    </Icon>
  );
}

// 137-4: ChevronIcon is the right-pointing arrow of a list section row, 14px.
// It is decoration. The row button carries aria-expanded, so a screen reader
// hears the state from the button and not from the icon.
export function ChevronIcon() {
  return (
    <Icon size={14} fine>
      <path d="M9 6l6 6-6 6" />
    </Icon>
  );
}

// 137-5: SearchIcon is the magnifier of the channel search button on the
// phone, 18px. It is decoration. The button carries aria-label "search
// messages".
export function SearchIcon() {
  return (
    <Icon size={18} fine>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Icon>
  );
}

// 137-10: ThreadsIcon is the threads button of the phone list head, 18px. It
// is a reply arrow that goes down and then right, the shape of the "↳" that
// the old threads row used. It is decoration. The button carries the label.
export function ThreadsIcon() {
  return (
    <Icon size={18} fine>
      <path d="M5 4v7a4 4 0 0 0 4 4h10" />
      <path d="M15 11l4 4-4 4" />
    </Icon>
  );
}

// 137-10: FilterIcon is a funnel, the filter button of the phone list head,
// 18px. It replaced a text magnifier. It is decoration. The button carries
// aria-label "filter conversations".
export function FilterIcon() {
  return (
    <Icon size={18} fine>
      <path d="M3.5 5h17l-6.5 7.5v5.5l-4 2v-7.5z" />
    </Icon>
  );
}

// 137-10: AddFriendIcon is a person with a plus, the add a friend button of
// the phone list head, 18px. It is decoration. The button carries the label.
export function AddFriendIcon() {
  return (
    <Icon size={18} fine>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M19 7v6" />
      <path d="M16 10h6" />
    </Icon>
  );
}

// 137-10: NewChannelIcon is a speech bubble with a plus, the new channel
// button of the phone list head, 18px. It is decoration. The button carries
// the label.
export function NewChannelIcon() {
  return (
    <Icon size={18} fine>
      <path d="M4 4.5h16v12H10l-4.5 3.5v-3.5H4z" />
      <path d="M12 7.5v6" />
      <path d="M9 10.5h6" />
    </Icon>
  );
}

// SendIcon is the outline paper plane of the send button, 18px.
export function SendIcon() {
  return (
    <Icon size={18} fine>
      <path d="M4 4l16 8-16 8 3-8Z" />
      <path d="M7 12h6" />
    </Icon>
  );
}
