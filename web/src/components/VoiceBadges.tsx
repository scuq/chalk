// 30-5 badge icons. They live here, not in Sidebar.tsx, so the hover card
// can import them without a cycle (131-3). Tiny inline SVGs in currentColor
// so they inherit the theme (the emoji variants 🔇/🎥 fight the green-on-black
// palette). Stroke style, 12px box.

export function MicOffIcon() {
  return (
    <svg
      class="chalk-voice-badge chalk-voice-badge--muted"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      aria-label="muted"
      role="img"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}

export function CamIcon() {
  return (
    <svg
      class="chalk-voice-badge chalk-voice-badge--cam"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-label="camera on"
      role="img"
    >
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 10l7-4v12l-7-4z" />
    </svg>
  );
}

// 131-1: deafened. Headphones with a stroke through them.
export function DeafIcon() {
  return (
    <svg
      class="chalk-voice-badge chalk-voice-badge--deaf"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-label="deafened"
      role="img"
    >
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <rect x="3" y="14" width="4" height="6" rx="1" />
      <rect x="17" y="14" width="4" height="6" rx="1" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}

export function ScreenIcon() {
  return (
    <svg
      class="chalk-voice-badge chalk-voice-badge--screen"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-label="sharing screen"
      role="img"
    >
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

