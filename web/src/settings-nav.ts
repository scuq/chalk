// 68-1: tab + filter index for the profile settings modal. ProfilePanel
// accumulated ~16 sections in one scroll; this maps each section to a tab
// and to searchable keywords. Pure so it can be tested without a DOM.

export type SettingsTab =
  | "account"
  | "appearance"
  | "chat"
  | "notifications"
  | "media";

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "account", label: "account" },
  { id: "appearance", label: "appearance" },
  { id: "chat", label: "chat" },
  { id: "notifications", label: "notifications" },
  { id: "media", label: "media" },
];

export type SectionId =
  | "identity"
  | "email"
  | "recovery"
  | "security"
  | "passkeys"
  | "about"
  | "appearance"
  | "chat"
  | "roster"
  | "parking"
  | "notifications"
  | "away"
  | "voice"
  | "storage"
  | "giphy"
  | "linkpreviews";

export interface SectionMeta {
  id: SectionId;
  tab: SettingsTab;
  title: string;
  // What a user might type to find a setting living in this section. The
  // filter matches whole sections, so each section lists its individual
  // settings here.
  keywords: string[];
}

export const SETTINGS_SECTIONS: SectionMeta[] = [
  {
    id: "identity",
    tab: "account",
    title: "identity",
    keywords: ["username", "display name", "email", "role", "session"],
  },
  {
    id: "email",
    tab: "account",
    title: "change email",
    keywords: ["email", "address", "verification"],
  },
  {
    id: "recovery",
    tab: "account",
    title: "recovery code",
    keywords: ["recovery", "phrase", "rotate", "words", "backup"],
  },
  {
    id: "security",
    tab: "account",
    title: "account security",
    keywords: [
      "password",
      "two-factor",
      "totp",
      "authenticator",
      "encryption phrase",
    ],
  },
  {
    id: "passkeys",
    tab: "account",
    title: "passkeys",
    keywords: ["passkey", "webauthn", "security key", "fingerprint"],
  },
  {
    id: "about",
    tab: "account",
    title: "about",
    keywords: ["version", "changelog", "build"],
  },
  {
    id: "appearance",
    tab: "appearance",
    title: "appearance",
    keywords: ["theme", "font", "text size", "scale", "dark", "light", "scrollbar"],
  },
  {
    id: "chat",
    tab: "chat",
    title: "chat",
    keywords: [
      "timestamps",
      "compact",
      "sidebar width",
      "name colors",
      "user colors",
      "composer",
      "emoticons",
      "emoji",
      "typing",
      "shorten links",
    ],
  },
  {
    id: "roster",
    tab: "chat",
    title: "channel list",
    keywords: ["grouping", "groups", "zuckermode", "channels"],
  },
  {
    id: "parking",
    tab: "chat",
    title: "parking lot",
    keywords: ["parking", "lot", "scratchpad"],
  },
  {
    id: "notifications",
    tab: "notifications",
    title: "notifications",
    keywords: [
      "sound",
      "volume",
      "mute",
      "silence",
      "badges",
      "rules",
      "alerts",
    ],
  },
  {
    id: "away",
    tab: "notifications",
    title: "away detection",
    keywords: ["idle", "away", "presence", "machine"],
  },
  {
    id: "voice",
    tab: "media",
    title: "voice & video",
    keywords: ["microphone", "mic", "camera", "devices", "call", "speaker"],
  },
  {
    id: "storage",
    tab: "media",
    title: "storage",
    keywords: ["cache", "images", "clear"],
  },
  {
    id: "giphy",
    tab: "media",
    title: "giphy",
    keywords: ["gif", "giphy"],
  },
  {
    id: "linkpreviews",
    tab: "media",
    title: "link previews",
    keywords: ["link previews", "cards", "domains", "embeds", "unfurl"],
  },
];

export const SECTION_TAB: Record<SectionId, SettingsTab> = Object.fromEntries(
  SETTINGS_SECTIONS.map((s) => [s.id, s.tab])
) as Record<SectionId, SettingsTab>;

const HAYSTACKS: [SectionId, string][] = SETTINGS_SECTIONS.map((s) => [
  s.id,
  [s.title, ...s.keywords].join(" ").toLowerCase(),
]);

// Empty or whitespace-only query returns null ("not filtering"), mirroring
// filterRoster's cheap sentinel. Otherwise every whitespace-separated term
// must be a substring of the section's title+keywords haystack.
export function matchSections(query: string): Set<SectionId> | null {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const hits = new Set<SectionId>();
  for (const [id, hay] of HAYSTACKS) {
    if (terms.every((t) => hay.includes(t))) hits.add(id);
  }
  return hits;
}
