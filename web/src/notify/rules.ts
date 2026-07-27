// chalk-web -- the notification rules engine: how much does this event
// matter, and what does that amount of mattering do?
//
// Two indirections, both deliberate:
//
//   event --rules--> priority     defaults per event type, overridable
//                                 per user and per channel
//   priority --profile--> actions sound / banner / blink, configured
//                                 once per priority level
//
// Actions are never attached to a user or a channel directly. "This
// friend should banner" is expressed as "this friend is P4" plus "P4
// banners", so changing what P4 means updates every P4 rule at once.
//
// Everything here is pure. Persistence lives in rules-store.ts, event
// delivery in bus.ts, and the sinks that act on an ActionSet in the
// caller (App.tsx).

export type Priority = 0 | 1 | 2 | 3 | 4; // 0 = mute: no actions at all

export type NotifyEventType =
  | "dm"
  | "mention"
  | "thread_reply"
  | "message"
  | "voice"
  | "channel_added"
  | "friend_request"
  | "governance";

// Order matters: this is the order the rules UI lists the defaults in.
// Loud, personal things first, same convention as SOUND_CATEGORIES.
export const NOTIFY_EVENT_TYPES: NotifyEventType[] = [
  "mention",
  "dm",
  "thread_reply",
  "message",
  "voice",
  "channel_added",
  "friend_request",
  "governance",
];

export const EVENT_TYPE_LABELS: Record<NotifyEventType, { label: string; desc: string }> = {
  mention: { label: "mentions", desc: "someone writes your handle" },
  dm: { label: "direct messages", desc: "a 1:1 message" },
  thread_reply: { label: "thread replies", desc: "a reply in a thread you're in" },
  message: { label: "every message", desc: "any new message in any channel" },
  voice: { label: "calls", desc: "someone starts a call in a voice channel" },
  channel_added: { label: "channel invites", desc: "you're added to a channel" },
  friend_request: { label: "friend requests", desc: "someone wants to add you" },
  governance: { label: "proposals", desc: "a proposal opens or resolves" },
};

export interface ActionSet {
  sound: boolean;
  banner: boolean;
  blink: boolean;
}

export interface NotifyRules {
  defaults: Record<NotifyEventType, Priority>;
  // userID -> priority. Applies to everything that person does, across
  // event types -- that's what "boost this friend" means.
  users: Record<string, Priority>;
  // channelID -> priority.
  channels: Record<string, Priority>;
}

// Keyed by the four real priorities; mute has no profile because mute
// means "do nothing", not "do a configurable nothing".
export interface NotifyProfiles {
  1: ActionSet;
  2: ActionSet;
  3: ActionSet;
  4: ActionSet;
}

// The unit the store persists and the sync slice will encrypt: one blob,
// whole-blob last-write-wins.
export interface RulesConfig {
  rules: NotifyRules;
  profiles: NotifyProfiles;
}

// Just enough of a NotifyEvent to resolve a priority. Structural so this
// module needs nothing from bus.ts.
export interface RuleFacts {
  type: NotifyEventType;
  senderUserID?: string;
  channelID?: string;
}

// Defaults preserve today's behaviour: every chat event made a sound
// before rules existed, so every priority includes one. Banner and blink
// arrive only at the top levels, and banner is inert anyway until the
// user grants Notification permission.
export const DEFAULT_PROFILES: NotifyProfiles = {
  1: { sound: true, banner: false, blink: false },
  2: { sound: true, banner: false, blink: false },
  3: { sound: true, banner: false, blink: true },
  4: { sound: true, banner: true, blink: true },
};

export const DEFAULT_TYPE_PRIORITIES: Record<NotifyEventType, Priority> = {
  mention: 4,
  dm: 4,
  thread_reply: 3,
  channel_added: 3,
  friend_request: 3,
  voice: 2,
  governance: 2,
  message: 1,
};

export function defaultRulesConfig(): RulesConfig {
  return {
    rules: { defaults: { ...DEFAULT_TYPE_PRIORITIES }, users: {}, channels: {} },
    profiles: {
      1: { ...DEFAULT_PROFILES[1] },
      2: { ...DEFAULT_PROFILES[2] },
      3: { ...DEFAULT_PROFILES[3] },
      4: { ...DEFAULT_PROFILES[4] },
    },
  };
}

// Most specific wins: a person you singled out beats the channel it
// happened in, which beats the kind of thing it was. A channel mute
// therefore also mutes mentions there, and a user override is the way
// back out -- documented behaviour, not an oversight.
export function resolvePriority(ev: RuleFacts, rules: NotifyRules): Priority {
  if (ev.senderUserID !== undefined) {
    const p = rules.users[ev.senderUserID];
    if (p !== undefined) return p;
  }
  if (ev.channelID !== undefined) {
    const p = rules.channels[ev.channelID];
    if (p !== undefined) return p;
  }
  return rules.defaults[ev.type];
}

const NO_ACTIONS: ActionSet = { sound: false, banner: false, blink: false };

export function actionsFor(priority: Priority, profiles: NotifyProfiles): ActionSet {
  if (priority === 0) return NO_ACTIONS;
  return profiles[priority];
}

export function isPriority(v: unknown): v is Priority {
  return v === 0 || v === 1 || v === 2 || v === 3 || v === 4;
}

// normalizeRulesConfig fills every field from a possibly-partial,
// possibly-garbage value -- same totality contract as
// normalizeSoundPrefs, and for the same reason: this shape comes back
// from localStorage today and from a decrypted synced blob later, and
// neither source is trustworthy enough to throw over.
export function normalizeRulesConfig(raw: unknown): RulesConfig {
  const out = defaultRulesConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;

  const rules =
    o.rules && typeof o.rules === "object" && !Array.isArray(o.rules)
      ? (o.rules as Record<string, unknown>)
      : {};

  const defaults =
    rules.defaults && typeof rules.defaults === "object" && !Array.isArray(rules.defaults)
      ? (rules.defaults as Record<string, unknown>)
      : {};
  for (const t of NOTIFY_EVENT_TYPES) {
    if (isPriority(defaults[t])) out.rules.defaults[t] = defaults[t] as Priority;
  }

  // Unknown keys are kept as-is: a userID or channelID is opaque here,
  // and dropping an override for a channel this device hasn't loaded yet
  // would silently delete a rule made on another device. Only the values
  // are validated.
  for (const [field, target] of [
    ["users", out.rules.users],
    ["channels", out.rules.channels],
  ] as const) {
    const m = rules[field];
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (k && isPriority(v)) target[k] = v;
    }
  }

  const profiles =
    o.profiles && typeof o.profiles === "object" && !Array.isArray(o.profiles)
      ? (o.profiles as Record<string, unknown>)
      : {};
  for (const p of [1, 2, 3, 4] as const) {
    const a = profiles[String(p)];
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const ao = a as Record<string, unknown>;
    for (const action of ["sound", "banner", "blink"] as const) {
      if (typeof ao[action] === "boolean") out.profiles[p][action] = ao[action] as boolean;
    }
  }

  return out;
}
