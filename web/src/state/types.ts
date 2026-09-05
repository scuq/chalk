// State types for the chalk SPA.
//
// Phase 08b extracts these from App.tsx because the state shape is now
// non-trivial: per-channel message arrays, channel list, active channel
// pointer, history-loaded markers, modal visibility.
//
// All shapes mirror proto.ts wire types but with client-side conveniences
// added (e.g. ChannelSummary's createdAt as Date, Message's ts as Date).

import { DEFAULT_SELF_HUE, clampHue } from "../chat/nickcolor";
import { normalizeHidden, type HiddenChannel } from "../chat/channel-hide";
import { SIDEBAR_WIDTH_DEFAULT, clampSidebarWidth } from "../chat/sidebar-width";
import { clampComposerHeight } from "../chat/composer-height";
import { parkingLotName } from "../parking";
import type { ConnectionState } from "../ws-client";
import type { AttachmentRef } from "../attachments/types";
import type {
  AuthAction,
  AuthConfig,
  AuthStage,
  EmailChangeState,
  InviteContext,
  LoginForm,
  MeResponse,
  MyInvitesState,
  RegistrationForm,
  RegistrationResult,
  VerifyEmailChangeState,
} from "../auth/types";
// Phase 09d-2b: admin panel uses these DTOs from the admin API client.
import type { AdminUser, BlacklistEntry } from "../auth/admin";
import { initialAuthState } from "../auth/types";

// ---- Domain types --------------------------------------------------------

export interface Message {
  id: string;
  channelID: string;
  seq: number;
  sender: string; // device_id; empty for purged-user messages
  // Phase 9.6i: user_id of the sender, resolved by the server via
  // JOIN on the devices table at fetch time. Empty when the
  // sender's device or user has been purged.
  senderUserID: string;
  ts: Date;
  body: string;
  // Phase 23d: message-suite key version. Undefined/0 = legacy plaintext
  // body; >=1 = the body was decrypted from ciphertext under the channel
  // key of that version (after decryptForChannel the body holds plaintext).
  keyVersion?: number;
  // Phase 10a: threading metadata. parentID set on thread replies;
  // threadID set on every message that's part of a thread (head
  // included, once 10d denormalizes -- for now, head's threadID is
  // empty and replies carry the thread_id pointing at the head).
  // replyCount only meaningful on thread heads in the main feed.
  parentID?: string;
  threadID?: string;
  replyCount?: number;
  // Phase 10d: highest seq among replies. Used for unread badge.
  lastReplySeq?: number;
  // Phase 10e: preview of the most recent reply.
  lastReplySenderUserID?: string;
  lastReplyBody?: string;
  lastReplyKeyVersion?: number;
  // Phase 26 (governance prereq): soft-delete tombstone. deleted=true means
  // the row was deleted; body is the "[message deleted]" placeholder. deletedBy
  // is the deleter's user_id; deletedAt is the deletion time. Undefined for a
  // live message.
  deleted?: boolean;
  deletedBy?: string;
  deletedAt?: Date;
  // Phase 37-3: set once the author has edited this message in place. body
  // already holds the edited text (only one version exists), so this drives
  // nothing but the "(edited)" marker. Undefined for a never-edited message.
  editedAt?: Date;
  // att-2: encrypted attachments linked to this message. Populated from the
  // live push (wireToMessage) and backfilled for history via the window list
  // query (attachments_merged). Undefined/empty for the common text message.
  attachments?: AttachmentRef[];
  // Client-generated idempotency key set on the optimistic row and echoed
  // back by the server. The reducer matches a server push to the optimistic
  // row by this key and replaces it (adopting the server id/seq/ts) rather
  // than appending a duplicate. Undefined for messages from other senders
  // and for history-fetched rows.
  clientMsgID?: string;
  // 42-3: our own read cursor for this row's thread, sent by the server with
  // the head row it decorates (history fetches only -- undefined on a live
  // push, which has no single recipient). The reducer folds it into
  // state.threadSeen on history_loaded; nothing reads it off the message
  // afterwards, so it is hydration input rather than render state.
  threadLastReadSeq?: number;
  // 42-3: whether we wrote this thread's head or any of its replies. Server-
  // computed from sender_device_id, so it never needs a decrypted body.
  threadInvolved?: boolean;
  // 83-2: envelope verification verdict for this row (crypto/envelope.ts's
  // typed set). Undefined when the body never decrypted (placeholder rows,
  // tombstones). "unsigned" is the uniform pre-83 legacy label. When the
  // signature verifies, senderUserID already holds the SIGNED sender (inner
  // wins over the server frame), so renderers need no second field.
  verify?: import("../crypto/envelope").VerifyStatus;
  // 83-2: the signed replay triple + object hash, present when this row
  // carried a well-formed envelope. What a reply (par_*), an edit or a
  // reaction binds to. For an edited row (83-3) the triple is the ORIGINAL
  // message's (recovered from the edit envelope's signed target), and
  // sigObjectHash is set only when the original's hash is actually known
  // (own send, live-opened original, or a verified revision chain).
  sigActor?: string;
  sigScope?: string;
  sigClientMsgID?: string;
  sigObjectHash?: string; // hex SHA-256(canonical || lp(sig64))
  // 83-3: append-only edit chain state. editHeadHash is the object hash of
  // the envelope currently displayed (original or latest edit) -- what the
  // NEXT edit must link to via prev_rev_hash. editPrevRevHash is the current
  // edit envelope's link; editAncestry is the chain verdict
  // (crypto/revisions.ts): verified / forked / unknown.
  editHeadHash?: string;
  editPrevRevHash?: string;
  editAncestry?: import("../crypto/revisions").EditAncestry;
}

// 42-7: one row of the thread inbox. camelCase mirror of proto.ThreadInboxEntry.
//
// headBody / lastReplyBody are the DECRYPTED previews and are optional because
// they are filled in asynchronously, per channel, after the row is on screen --
// undefined means "not decrypted yet", which the panel renders as a skeleton.
export interface ThreadInboxRow {
  channelID: string;
  threadID: string;

  headSeq: number;
  headTS: Date;
  headSenderUserID?: string;
  headBody?: string;
  headKeyVersion?: number;
  headDeleted?: boolean;

  lastReplySeq: number;
  lastReplyTS: Date;
  lastReplySenderUserID?: string;
  lastReplyBody?: string;
  lastReplyKeyVersion?: number;
  lastReplyDeleted?: boolean;

  replyCount: number;
  // The server's view of our cursor when it built this row. state.threadSeen may
  // be ahead of it; isThreadUnread takes the max of both.
  lastReadSeq: number;
  involved: boolean;
  // 45-4: was this row unread when the SERVER last counted, i.e. is it one of
  // the threads behind threadInboxUnreadTotal? Frozen at the ack -- unlike
  // lastReplySeq, which live replies bump -- because it is what the derived
  // count subtracts from that total (threadsNeedingYouCount).
  unreadAtFetch: boolean;
}

// 37-5: one member's decrypted reaction set for one message. Re-exported from
// chat/reactions.ts so the state layer and the pure tally agree on the shape.
export type { ReactionSet } from "../chat/reactions";
import type { ReactionSet } from "../chat/reactions";

// phase 08c: ChannelMember pairs a user_id with their handle.
export interface ChannelMember {
  userID: string;
  handle: string;
}

export interface ChannelSummary {
  id: string;
  name: string;
  isDM: boolean;
  createdBy: string;
  createdAt: Date;
  memberIDs: string[];
  members: ChannelMember[]; // phase 08c; empty when server didn't send any
  currentKeyVersion: number; // phase 25; the version new messages encrypt under
  rotationPending: boolean; // member removal: a removal happened, key not yet rotated
  governanceMode: string; // gov-2; "dictator" | "democratic" (default "dictator")
  channelType: string; // 30-4; "text" | "voice" (default "text")
  // 54-2: the creator's grouping suggestion, set once at creation. The group
  // a channel actually renders under is per-user (override prefs, 54-4);
  // this is only the seed. "General" for DMs and pre-54 channels.
  groupName: string;
  // 106-3: the optional abbreviation (≤10 chars); ""/absent when none.
  // Which of name / shortName the roster shows is prefs.roster.nameStyle.
  // Optional like expiresAt so pre-106 fixtures and summaries still type.
  shortName?: string;
  // 33-1: read-state SEED only, as of the frame that delivered this summary.
  // Live unread state is state.unread[channelID] -- render from there, never
  // from these. A channel_event summary carries zeros because the server
  // builds it without a user scope.
  lastSeq: number;
  lastReadSeq: number;
  // 62-3: newest-message activity SEED, same contract as lastSeq above:
  // live state is state.activity[channelID] -- render from there. Metadata
  // only; the ciphertext preview rides outside the reducer (App's cipher
  // stash) until decrypted. All absent on channel_event summaries.
  lastMsgID?: string;
  lastMsgTS?: number; // unix-millis
  lastMsgSeq?: number;
  lastMsgSender?: string; // user id; absent when the sender was purged
  lastMsgDeleted?: boolean;
  // 80-12: when an ephemeral channel self-destructs (unix-millis). Absent =
  // permanent. Gates the guest-invite UI; the countdown renders from it (80-14).
  expiresAt?: number;
}

// 62-3: per-channel newest-message activity, the unified conversation
// list's sort key and preview. Seeded from the channel listing, kept live
// by the message/edit/delete pushes; merges are seq-monotonic (a
// channel_event summary carries no activity and must not wipe this).
// preview is decrypted plaintext (rendered through previewText) or null
// while only ciphertext is held.
export interface ChannelActivity {
  msgID: string | null;
  ts: number; // unix-millis
  seq: number;
  senderUserID: string | null;
  preview: string | null;
  deleted: boolean;
}

// 33-1/33-3: per-channel unread state.
//
// lastSeq/lastReadSeq are seeded from the server (which syncs the cursor
// across devices) and kept live by incoming messages and read_state pushes.
// mention is derived purely client-side from decrypted message bodies --
// the server never sees who was mentioned, so it cannot tell us. It is
// therefore best-effort: it covers what this client has decrypted.
export interface ChannelUnread {
  lastSeq: number;
  lastReadSeq: number;
  mention: boolean;
}

// 33-4: the frozen "where I left off" window for the channel being viewed.
//
// It has to be frozen because opening a channel marks it read within a
// round-trip (33-1) -- a divider keyed on the live cursor would vanish the
// moment you arrived. Both ends are captured, not just the start: messages
// that arrive while you sit in the channel land above throughSeq and are
// deliberately left unmarked, so a busy channel doesn't slowly turn into a
// wall of highlight.
export interface UnreadMark {
  // Read cursor at capture time. The divider goes before the first message
  // with seq > afterSeq.
  afterSeq: number;
  // Newest message that existed at capture time. Highlighting stops here.
  throughSeq: number;
}

export const emptyUnread: ChannelUnread = {
  lastSeq: 0,
  lastReadSeq: 0,
  mention: false,
};

// hasUnread is the single definition of "show a dot" so the sidebar and the
// mark-read effect can never disagree about it.
export function hasUnread(u: ChannelUnread | undefined): boolean {
  return u !== undefined && u.lastSeq > u.lastReadSeq;
}

// countsAsUnread narrows hasUnread for a VOICE channel: its text is a
// scratchpad for the call in progress (45-1), so a dot on it is only ever news
// to someone in the room. Outside the room it is a nag about text you were not
// part of and that gets destroyed the moment the call ends -- and being pulled
// into a call by an unread dot is exactly the behaviour a voice channel should
// not have.
export function countsAsUnread(
  u: ChannelUnread | undefined,
  channelType: string,
  inVoiceRoom: boolean,
): boolean {
  if (!hasUnread(u)) return false;
  return channelType !== "voice" || inVoiceRoom;
}

// 30-4: one live occupant of a voice room, as tracked from the roster ack +
// joined/left/state pushes. Keyed by (userID, deviceID) -- the same user on
// another device is a distinct participant (the server rejects that in v1,
// but the shape supports it).
export interface VoiceParticipant {
  userID: string;
  deviceID: string;
  muted: boolean;
  videoOn: boolean;
  screenOn: boolean;
  // 109-1: they have deafened themselves -- muted AND not listening. Always
  // accompanied by muted, since deafening mutes (see session.toggleDeafen).
  deafened: boolean;
}

// gov-2: a governance proposal as the client tracks it. Counts-only tally
// (per-voter ballots are never shipped, H7); yourVote is the caller's own
// ballot ("yes" | "no" | "").
export interface ProposalView {
  id: string;
  channelID: string;
  type: string;
  targetID: string;
  payload?: unknown;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  status: string;
  eligible: number;
  yes: number;
  no: number;
  voted: number;
  yourVote: string;
}

export interface Friend {
  userID: string;
  handle: string; // phase 08c; empty if server didn't return one
}

// ---- Phase 9.6a: friends panel state ------------------------------------
//
// activeTab: which of the three tabs is currently shown.
// addInput: the username being typed in the "add" tab.
// addBusy: true between submit and ack (covers the lookup + WS
//   send + ack roundtrip; the panel disables submit while true).
// addError: human-readable error to display under the add input.
// pendingActionUserID: when an accept/decline/remove is mid-flight,
//   this is the target user's id; UI disables that row's actions.
export interface FriendsPanelState {
  activeTab: "add" | "pending" | "friends";
  addInput: string;
  addBusy: boolean;
  addError: string | null;
  pendingActionUserID: string | null;
}

export const initialFriendsPanelState: FriendsPanelState = {
  activeTab: "add",
  addInput: "",
  addBusy: false,
  addError: null,
  pendingActionUserID: null,
};

// Phase 9.6c: presence map. Keyed by friend user_id. Values are
// the server's aggregated state strings ("online", "away", "offline").
// Absent keys mean "unknown / not subscribed" — treated as offline
// in the UI.
export type PresenceMap = Record<string, string>;

// 92-2: last-activity timestamps (unix-millis), keyed by the same user_ids
// PresenceMap uses and written by the same three actions. A sibling map rather
// than a widened PresenceMap value: every other reader of presence wants the
// state string alone, and only the roster hover card wants the time.
export type LastSeenMap = Record<string, number>;

// ---- Reducer state -------------------------------------------------------

// Phase 9.7a: typed view over the server's opaque prefs JSON.
// Keys with unknown values are tolerated -- the SPA only reads what it
// knows. Add new keys here as features land. Optional shape means the
// server's "no row" state maps cleanly to an empty object.
// Phase 9.7d: typed sub-object for chat display settings. All
// fields optional; callers resolve defaults via selectChatPrefs().
// Phase 9.7e: per-user color rule. First-match-wins by handle.
export interface UserColorRule {
  // Lowercased on save so matches are case-insensitive at lookup.
  handle: string;
  // CSS color. The picker writes #rrggbb hex.
  color: string;
  // "all" applies in every channel; "dm" only in 1:1 direct messages.
  scope: "all" | "dm";
}

export interface ChatPrefs {
  showTimestamps?: boolean;       // default true
  timestampFormat?: "hms" | "hm" | "relative"; // default "hms"
  compactMode?: boolean;          // default false
  // Phase 9.7e: per-user color overrides for sender labels in chat.
  userColors?: UserColorRule[];
  // Phase 9.7f: nick coloring. Master switch (default ON), the viewer's own
  // color, and explicit per-handle picks. Hues (0..359) rather than hex so
  // the same value stays readable on every theme -- see chat/nickcolor.ts.
  userColorsEnabled?: boolean;
  selfColorHue?: number;
  userHues?: Record<string, number>;
  // Phase 9.7h: composer tool presentation. "text" renders FILE / GIF / EMOJI
  // labels; "icons" renders glyphs. Default "icons" since 44-5 -- the tools
  // are a 2x2 block against the input now, and word labels make it three
  // times as wide as the glyphs do for no gain in clarity.
  composerToolStyle?: "text" | "icons";
  // 42-1: replace typed emoticons (":)") with the matching emoji as you type.
  // Default ON -- it's what every chat client before the web did.
  emoticons?: boolean;
  // 33-4: sidebar column width in px, set by dragging its edge. Clamped to
  // [SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX] on both write and read. Ignored
  // on mobile, where the sidebar is a drawer with its own sizing.
  sidebarWidth?: number;
  // 91-1: composer height in px, set by dragging the divider above it. 0 (and
  // absent) mean auto -- the two rows the field has always been. Clamped on
  // both write and read. Ignored on mobile, where the footer stacks.
  composerHeight?: number;
  // 43-4: "X is typing" indicators. Default ON, and reciprocal -- off means
  // this client neither sends pings nor renders anyone else's, so you can't
  // watch without being watched.
  typingIndicators?: boolean;
  // 67-1: render long pasted URLs as a "[link to host]" label. Default ON.
  // Display-only -- the href underneath is always the full raw URL.
  shortenLinks?: boolean;
  // 77-2: render `code`, **bold** and *italic* in messages. Default OFF, and
  // receive-side only -- the composer never rewrites or previews anything, so
  // the literal characters always go over the wire and everyone else reads
  // them as typed unless they turn this on too.
  nanoMarkdown?: boolean;
}

// 53-1: the parking lot's own settings. Account-synced rather than
// per-device: the title is a personal label, and hiding the row is a decision
// about your chalk, not about this browser. Whether you are parked right now
// is the per-device half -- see ../parking.ts.
export interface ParkingLotPrefs {
  // Displayed instead of "Parking Lot". Normalized on read, not on write, so
  // an old or hand-edited value can never leave the row unlabelled.
  name?: string;
  // Drops the row from the sidebar entirely. Parking stays reachable through
  // the setting itself, which is the only way back if you hide it while parked.
  hidden?: boolean;
  // 53-5: while parked, cover everything the parking lot leaves standing --
  // the roster, the header and your own handle in it, the call bar, whatever
  // modal was open -- and drop the two things that leak with the window out of
  // view: the tab's unread count and the notification sounds.
  //
  // Off by default, and not because it is a lesser setting: every session
  // starts parked, so on by default would greet every reload with a blurred
  // window and no obvious reason for it.
  screen?: boolean;
}

export interface UserPrefs {
  // Phase 9.7b: theme name. "green" = default terminal theme. Other valid
  // values: "light", "snazzy-light", "warmwhite", "vscode-light",
  // "catppuccin-latte", "cyberpunk", "solarized-dark", "tokyo-night", "lcars",
  // "blade-runner", "azeroth", "darkord", "exchalk", "catppuccin-mocha". The
  // picker in ProfilePanel is the source of truth; each
  // has a [data-theme=...] block in theme.css.
  theme?: string;
  // Phase 9.7d: chat-display sub-prefs.
  chat?: ChatPrefs;
  // att-4: Giphy consent (tri-state). Absent = "unset" (default OFF): no
  // Giphy fetching until the viewer opts in. "enabled" renders received
  // Giphy URLs as <img> from Giphy's CDN; "disabled" keeps them inert text.
  // See selectGiphyPref / decideGiphyRender in ../giphy/giphy.ts.
  giphy?: "unset" | "enabled" | "disabled";
  // 44-4: microphone tuning and the voice keybinds, so a second machine isn't
  // a fresh calibration job. Deliberately NOT the chosen input device -- see
  // voice/mic-prefs.ts. Shape is SyncedMicPrefs; typed loosely here so
  // state/types.ts doesn't pull in the voice module, and because mic-prefs'
  // own normalizer is the thing that validates it.
  mic?: Record<string, unknown>;
  // 50-6: the notification rules blob -- AES-256-GCM ciphertext, base64.
  // The server never sees inside it; see notify/rules-sync.ts.
  notify_rules_enc?: string;
  // 66-3: the per-peer "mute for me" list, sealed the same way and for the
  // same reason -- it names who you silenced, and where. See
  // voice/peer-audio-sync.ts.
  voice_peer_audio_enc?: string;
  // 84-2: the identity pins, sealed the same way. Ciphertext because it is the
  // device's own trust ledger, and the server is the party it defends against.
  // See crypto/pin-backup.ts.
  identity_pins_enc?: string;
  // 53-1: the parking lot's title + whether its row shows.
  parkingLot?: ParkingLotPrefs;
  // 54-3: roster display prefs (channel grouping).
  roster?: RosterPrefs;
  // 57-2: link-preview consent (tri-state). Absent = "unset" (default OFF):
  // no sender-side preview generation until the user opts in. Gates only
  // GENERATION -- received cards render from E2E data with zero fetches.
  // See selectLinkPreviewPref in ../linkpreview/linkpreview.ts.
  linkpreview?: "unset" | "enabled" | "disabled";
  // 57-2: per-user whitelist overrides layered onto the server's default
  // list (effectiveLinkPreviewDomains): added domains auto-offer previews,
  // removed ones stop doing so.
  linkpreviewDomains?: LinkPreviewDomainPrefs;
  // 57-2: display-only -- hide received preview cards (render just the
  // text). Independent of the consent pref above.
  linkpreviewHideCards?: boolean;
  // 66-1: how a browser that has never been used for voice starts out.
  voice?: VoicePrefs;
  // [extend with more keys in future phases]
}

// 66-1: the account-wide voice default. Only a DEFAULT: the live mute state
// stays per-device (voice/session.ts), because whether your mic is hot right
// now is a fact about the room you are sitting in. This is what a machine with
// no answer of its own uses -- a new browser, a wiped profile, a private
// window -- so "muted" does not have to be re-set on every one of them.
export interface VoicePrefs {
  joinMuted?: boolean; // default true
  /** 66-5: round-trip time on each remote tile, off by default -- it is a
   * number most calls never need, and a permanent one is a permanent worry. */
  showLatency?: boolean;
}

/** selectJoinMuted resolves the 66-1 default. Absent = muted: joining a room
 * with a hot mic you did not ask for is the worse failure. */
export function selectJoinMuted(prefs: UserPrefs | undefined): boolean {
  return prefs?.voice?.joinMuted !== false;
}

/** selectVoicePrefs: the sparse blob as stored, for the settings panel. */
export function selectVoicePrefs(prefs: UserPrefs | undefined): VoicePrefs {
  return prefs?.voice ?? {};
}

// 57-2: link-preview whitelist overrides as stored (sparse).
export interface LinkPreviewDomainPrefs {
  added?: string[];
  removed?: string[];
}

// 54-3: roster prefs as stored (sparse). groupingEnabled toggles the
// grouped channels view; groupOverrides (54-4) maps channel id -> the group
// THIS user files it under, overriding the creator's suggestion.
export interface RosterPrefs {
  groupingEnabled?: boolean;
  groupOverrides?: Record<string, string>;
  // 78-1: channels this user has taken off their roster, by channel id.
  // Typed loosely as stored; normalizeHidden owns what a valid entry is.
  hidden?: Record<string, { mode?: string; seq?: number }>;
  // 62-5: "zucker" swaps the phone's drawer navigation for one WhatsApp-
  // style conversation list (Zuckermode). Synced account-wide but consumed
  // only on mobile -- the chat.sidebarWidth precedent: desktop ignores it.
  viewMode?: "classic" | "zucker";
  // 106-3: "short" renders each channel's short name in the roster where
  // one is set; anything else (and absent) is the full name.
  nameStyle?: "full" | "short";
}

// Phase 9.7d: resolved chat prefs (all fields required + defaulted).
// Components read this shape instead of UserPrefs["chat"] directly so
// they don't have to deal with undefined at every render.
export interface ResolvedChatPrefs {
  showTimestamps: boolean;
  timestampFormat: "hms" | "hm" | "relative";
  compactMode: boolean;
  // Phase 9.7e: defaulted to [] when prefs.chat.userColors is absent.
  userColors: UserColorRule[];
  // Phase 9.7f: defaulted below (coloring ON, blueish self color, no picks).
  userColorsEnabled: boolean;
  selfColorHue: number;
  userHues: Record<string, number>;
  // Phase 9.7h: defaulted to "icons" (44-5).
  composerToolStyle: "text" | "icons";
  // 42-1: defaulted to true.
  emoticons: boolean;
  // 33-4: defaulted + clamped.
  sidebarWidth: number;
  // 91-1: defaulted to auto (0) + clamped.
  composerHeight: number;
  // 43-4: defaulted to true.
  typingIndicators: boolean;
  // 67-1: defaulted to true.
  shortenLinks: boolean;
  // 77-2: defaulted to false -- it is opt-in.
  nanoMarkdown: boolean;
}

// selectChatPrefs takes the (possibly sparse) prefs.chat and fills in
// defaults. Pure function; safe to call inline in render.
export function selectChatPrefs(prefs: UserPrefs | undefined): ResolvedChatPrefs {
  const c = prefs?.chat ?? {};
  return {
    showTimestamps: c.showTimestamps ?? true,
    timestampFormat: c.timestampFormat ?? "hms",
    compactMode: c.compactMode ?? false,
    userColors: Array.isArray(c.userColors) ? c.userColors : [],
    // 9.7f: ON by default -- the point of the feature is that everyone is
    // colored without configuring anything.
    userColorsEnabled: c.userColorsEnabled ?? true,
    selfColorHue:
      typeof c.selfColorHue === "number" ? clampHue(c.selfColorHue) : DEFAULT_SELF_HUE,
    userHues:
      c.userHues && typeof c.userHues === "object" && !Array.isArray(c.userHues)
        ? (c.userHues as Record<string, number>)
        : {},
    composerToolStyle: c.composerToolStyle === "text" ? "text" : "icons",
    emoticons: c.emoticons ?? true,
    sidebarWidth:
      c.sidebarWidth === undefined
        ? SIDEBAR_WIDTH_DEFAULT
        : clampSidebarWidth(c.sidebarWidth),
    composerHeight: clampComposerHeight(c.composerHeight),
    typingIndicators: c.typingIndicators ?? true,
    shortenLinks: c.shortenLinks ?? true,
    nanoMarkdown: c.nanoMarkdown ?? false,
  };
}

// 54-3: resolved roster prefs, same contract as ResolvedChatPrefs.
// Grouping defaults ON: with every channel in 'General' the sidebar renders
// exactly as before (a single group draws no headers), so the default only
// becomes visible once a second group exists.
export interface ResolvedRosterPrefs {
  groupingEnabled: boolean;
  // 54-4: channel id -> group name. Only sane entries survive resolution
  // (string values, non-empty after trim); everything else reads as "no
  // override" rather than a group named "" or a crash on junk prefs.
  groupOverrides: Record<string, string>;
  // 62-5: anything but the exact string "zucker" resolves to classic.
  viewMode: "classic" | "zucker";
  // 78-1: channel id -> hide entry, junk dropped. Whether an entry actually
  // hides the channel depends on live unread state -- see isHidden.
  hidden: Record<string, HiddenChannel>;
  // 106-3: anything but the exact string "short" resolves to full.
  nameStyle: "full" | "short";
}

export function selectRosterPrefs(prefs: UserPrefs | undefined): ResolvedRosterPrefs {
  const r = prefs?.roster ?? {};
  const overrides: Record<string, string> = {};
  if (r.groupOverrides && typeof r.groupOverrides === "object" && !Array.isArray(r.groupOverrides)) {
    for (const [id, g] of Object.entries(r.groupOverrides)) {
      if (typeof g !== "string") continue;
      const trimmed = g.trim();
      if (trimmed) overrides[id] = trimmed;
    }
  }
  return {
    groupingEnabled: r.groupingEnabled ?? true,
    groupOverrides: overrides,
    viewMode: r.viewMode === "zucker" ? "zucker" : "classic",
    hidden: normalizeHidden(r.hidden),
    nameStyle: r.nameStyle === "short" ? "short" : "full",
  };
}

// 53-1: resolved parking-lot prefs, same contract as ResolvedChatPrefs.
export interface ResolvedParkingLotPrefs {
  name: string;
  hidden: boolean;
  screen: boolean;
}

export function selectParkingLotPrefs(
  prefs: UserPrefs | undefined,
): ResolvedParkingLotPrefs {
  const p = prefs?.parkingLot ?? {};
  return {
    name: parkingLotName(p.name),
    hidden: p.hidden === true,
    screen: p.screen === true,
  };
}

// 53-4: the screen parking hid, kept for the way back. Indexed off AppState so
// it cannot drift from the fields it restores.
export interface ParkedReturn {
  openThread: AppState["openThread"];
  openPanel: AppState["openPanel"];
}

export interface AppState {
  // Connection.
  wsState: ConnectionState;
  wsDetail: string; // human-readable status detail when connecting/closed/error
  user: { id: string; device: string; handle: string } | null;

  // Channels.
  channels: Record<string, ChannelSummary>; // by channel id
  channelOrder: string[]; // sidebar order, newest-first
  activeChannelID: string | null;

  // Messages, per channel. Missing key means "history not yet fetched."
  messages: Record<string, Message[]>; // by channel id
  historyLoaded: Record<string, boolean>; // per-channel
  // 55-1: true once a history page came back short -- the beginning of the
  // channel is loaded and there is nothing older to page for. Sticky for
  // the session: live messages append and can never un-complete it.
  historyComplete: Record<string, boolean>; // per-channel

  // 33-1: unread + mention state per channel id. Kept out of ChannelSummary
  // so a channel_event summary (which the server builds without a user
  // scope, hence zeroed cursors) can't clobber live state.
  unread: Record<string, ChannelUnread>;

  // 62-3: newest-message activity per channel id, for the unified
  // conversation list (Zuckermode): sort key + decrypted preview. Same
  // out-of-ChannelSummary reasoning as unread above; merges are
  // seq-monotonic.
  activity: Record<string, ChannelActivity>;

  // 33-4: frozen unread window driving the "new messages" divider and the
  // highlighted rows. Only ever holds the channel currently being viewed --
  // a mark for any other channel is stale by definition, since entering a
  // channel reads it.
  unreadMarks: Record<string, UnreadMark>;

  // gov-2: governance proposals by channel id (open + recently resolved).
  proposals: Record<string, ProposalView[]>;

  // 30-4: live voice-room occupancy by channel id. Fed by voice_join_ack
  // (own join), voice_roster_ack, and the joined/left/state pushes (which go
  // to ALL channel members, so sidebar occupancy can render in 30-5).
  voiceRosters: Record<string, VoiceParticipant[]>;
  // 30-6: whether the server has voice enabled (welcome.voice_enabled).
  // Gates the create-modal voice option, the in-channel call panel, and
  // roster seeding. false until the welcome frame says otherwise.
  voiceEnabled: boolean;

  // 82-6: whether the server requires signed channel-key wraps
  // (welcome.wrap_sig_required). Handed to ChannelCrypto, which latches it
  // for the session. false until the welcome frame says otherwise.
  wrapSigRequired: boolean;

  // 82-8: who has joined each channel during this session, until dismissed.
  //
  // Membership is asserted by the SERVER (phase 83 is what makes it
  // authenticated), and a key holder auto-reshares the channel key to whoever
  // appears in the roster. So a server that adds a principal it controls gets
  // the key handed to it -- by a legitimate member, automatically. The client
  // cannot prevent that yet; what it can do is refuse to let it happen
  // SILENTLY. Session-scoped and local: this is a "look what just happened",
  // not an audit log.
  recentJoins: Record<string, Array<{ userID: string; handle: string }>>;
  // 83-7 (D.6): OBSERVED roster-change notices per channel -- derived by
  // diffing the roster the client sees against the one it last persisted,
  // so they fire even for a change that produced no server event (a direct
  // database write). Distinct from recentJoins, which is event-sourced.
  rosterNotices: Record<string, import("../chat/roster-observe").RosterNotice[]>;

  // 39-1: the build we're talking to (welcome.server_version/_commit), shown
  // as the header version badge. Empty until the welcome frame lands.
  serverVersion: string;
  serverCommit: string;

  // 46-2: "the server moved under us". serverBuildAtLoad is the build key
  // from the FIRST welcome of this page load -- null before it, so the very
  // first welcome can never flag an update (this tab's bundle came from
  // whatever build answered it). dismissedBuild remembers which build the
  // user waved off, so a plain reconnect doesn't bring the pill back but the
  // next deploy does. Neither is persisted: a reload is what clears them.
  serverBuildAtLoad: string | null;
  updateAvailable: boolean;
  dismissedBuild: string | null;
  // 46-3: the server said it is going down, so the disconnect about to show
  // up is expected. Transient, cleared by the next welcome. Only a hint --
  // whether this tab is stale is decided by the build comparison, not by this.
  serverRestarting: boolean;

  // Friends, fetched lazily when the create-channel modal opens.
  friends: Friend[];
  // Phase 9.6a: incoming + outgoing pending friend requests.
  pendingIncoming: Friend[];
  pendingOutgoing: Friend[];
  // Phase 9.6a: FriendsPanel UI state.
  friendsPanel: FriendsPanelState;
  // Phase 9.6b: when a friend without a DM is clicked, the SPA
  // sends create_channel and stashes the friend's user_id here.
  // The matching channel_added action activates that channel and
  // clears the field. Null when no DM-create is in flight.
  dmPendingForUserID: string | null;
  // Phase 9.6c: per-friend presence state. Keys are user_ids.
  presence: PresenceMap;
  // 92-2: when each of those friends was last active. Keyed like `presence`
  // and cleared with it; a friend can be in `presence` and missing here if
  // their push carried no usable timestamp.
  lastSeen: LastSeenMap;
  // Phase 9.6j: presence override for the local user.
  // "auto" tracks document visibility; "online" / "away"
  // force the state. The SPA sends presence_update whenever
  // myEffectivePresence changes.
  myPresenceMode: "auto" | "online" | "away";
  // The current effective state we've told the server about.
  // "offline" means we're disconnected (no need to send
  // anything; server handles via WS close).
  myEffectivePresence: "online" | "away" | "offline";

  // Phase 9.7a: user preferences. Loaded via prefs_get on connect;
  // updated via prefs_set + prefs_changed push.
  prefs: UserPrefs;
  // True once prefs_get_ack has arrived at least once this session.
  // Used to defer "apply theme" until we know what's stored.
  prefsLoaded: boolean;

  // Phase 10b: which thread is currently open in the side panel.
  // null when no thread is open. The threadID is always the thread
  // head's id (computed by resolveThreadID).
  openThread: { channelID: string; threadID: string } | null;

  // 53-1: parked -- the conversation pane is showing the parking lot instead
  // of whatever activeChannelID points at. The channel pointer is deliberately
  // left alone: parking is a screen state, not a navigation, and the channel
  // it hides is still the one every effect keyed on activeChannelID is talking
  // about. What parking does change is that nothing is being read, so the
  // mark-read effect and the notification banners both stand down.
  parked: boolean;

  // 53-4: what parking took off the screen, so the way back can put it there
  // again -- the channel is still pointed at, but the thread and the side panel
  // were closed. Null unless parked, and dropped the moment a navigation makes
  // it stale (picking a channel, opening a thread from the inbox), so "unpark"
  // can never restore a view of somewhere you have since left.
  parkedReturn: ParkedReturn | null;

  // Phase 10c: thread message caches.
  //   threadMessages[threadID] is the list of replies for that thread,
  //   in seq order (oldest first). The thread head itself is NOT here;
  //   the panel reads it from the channel cache.
  //   threadLoaded[threadID] is true once a fetch_thread_ack has EVER
  //   arrived for that thread; the panel uses it to distinguish "loading"
  //   from "empty thread" (latter shouldn't happen but the rendering is
  //   robust either way).
  //
  // 42-10: threadLoaded is not a fetch guard. It used to be one, which is
  // what made a thread's replies a once-per-session fetch -- a reply that
  // landed while the socket was down was never pushed and never re-fetched,
  // so the panel stayed frozen for the rest of the session. The guard is now
  // threadFetchInFlightRef in App.tsx, which tracks the REQUEST; this tracks
  // the ACK, and staying true across a refetch is exactly what keeps the
  // replies on screen instead of flashing the loading placeholder.
  threadMessages: Record<string, Message[]>;
  threadLoaded: Record<string, boolean>;

  // 37-5: decrypted reaction sets, keyed by message id, then holding one
  // entry per member who has reacted.
  //
  // Deliberately a PARALLEL record rather than a field on Message. Server
  // rows overwrite message rows wholesale by id in history_loaded, and the
  // key-ready backstop re-fetches history on every channel switch, so
  // anything hung off Message that the feed query doesn't echo would
  // silently vanish. Reactions come from their own frames, so they live in
  // their own slice and survive.
  reactions: Record<string, ReactionSet[]>;

  // ---- 42-7: the cross-channel thread inbox --------------------------
  //
  // Two ARRAYS, not a Record: the order is the server's (newest first) and
  // there is at most a page of each, so keying by id would only add a sort
  // back in. Kept as two lists for the same reason the server sends two --
  // paginating the active list must never be able to suppress the aged one.
  //
  // Previews arrive as ciphertext and are decrypted per channel AFTER the rows
  // render, so headBody/lastReplyBody are absent on a fresh row and filled in
  // later. Absent means "not decrypted yet", never "empty".
  threadInboxActive: ThreadInboxRow[];
  threadInboxAgedUnread: ThreadInboxRow[];
  threadInboxLoaded: boolean;
  threadInboxHasMoreActive: boolean;
  threadInboxUnreadTotal: number;
  threadInboxWindowHours: number;
  // Set when a live reply arrives for a thread we hold no row for. The client
  // cannot invent a row -- it has no way to know `involved` -- so it asks for a
  // refetch instead. App.tsx debounces on this.
  threadInboxStale: boolean;

  // 42-7: threads with a reply that mentions us. A PARALLEL slice, for the
  // reason the reactions comment above gives: anything hung off a row that a
  // server payload also carries gets clobbered when that payload is re-applied.
  // Mentions come from decrypted plaintext the server has never seen, so they
  // live on their own and survive a refetch.
  threadMentions: Record<string, boolean>;

  // Phase 10d: highest reply seq the user has "seen" per thread, used to
  // compute unread badges. A reply with seq > threadSeen[threadID] counts as
  // unread.
  //
  // 42-4: this used to be persisted to localStorage per user, which made it
  // per-DEVICE -- reading a thread on your phone left the badge lit on your
  // laptop forever. It is now server-backed (thread_reads, migration 0047) and
  // hydrated two ways, both bounded: history rows carry the viewer's cursor for
  // their own thread (42-3), and mark_thread_read/thread_read_state keep it in
  // sync live. Nothing writes it to disk any more.
  threadSeen: Record<string, number>;
  friendsLoaded: boolean;

  // UI.
  createModalOpen: boolean;

  // Phase 09b sub-step 4: auth-flow state. Spread from AuthState
  // for typing convenience but kept conceptually separate. See
  // src/auth/types.ts for the full shape and stage diagram.
  // Sub-step 5b adds login form state and the /me identity.
  authStage: AuthStage;
  authConfig: AuthConfig | null;
  registration: RegistrationForm;
  registrationResult: RegistrationResult | null;
  login: LoginForm;
  me: MeResponse | null;

  // Phase 09c-2 auth state:
  inviteContext: InviteContext | null;
  verifyEmailChange: VerifyEmailChangeState | null;
  myInvites: MyInvitesState;
  emailChange: EmailChangeState;
  // Phase 09d-2a: first-run admin enrollment via URL param.
  adminClaimUsername: string | null;

  // Phase 09c-2 UI: which in-chat panel is open (if any).
  // null = no panel. "invites" → InvitesPanel modal.
  // "profile" → ProfilePanel modal. Mutually exclusive with
  // createModalOpen (only one modal-equivalent at a time).
  openPanel:
    | "invites"
    | "profile"
    | "friends"
    | "members"
    | "governance"
    // 42-8: the cross-channel thread inbox.
    | "threads"
    // 50-4: notification rules + priorities.
    | "notifications"
    // 61-2: message search over what this client holds.
    | "search"
    | null;
  // Phase 09c-2 refresh: spinner state for the ProfilePanel refresh
  // button. InvitesPanel's spinner uses myInvites.loading (which is
  // already there); for profile we need a dedicated flag because
  // the /me refetch isn't gated on a panel-open transition.
  profileRefreshing: boolean;

  // ---- Phase 09d-2b: admin moderation panel ------------------------
  // Top-level route. "chat" = normal chat UI. "admin" = full-screen
  // moderation panel. Driven by ?path on initial load + the
  // browser's history API (pushState/popstate). Only admins reach
  // "admin"; the StatusBar entry that flips this is gated on
  // me.role === "admin", and App.tsx bounces non-admins back to
  // "chat" if they somehow land here (e.g. demoted between page
  // loads).
  route: "chat" | "admin";
  // Admin panel data + UI state. Lazily populated when the route
  // changes to "admin"; reset on route back to "chat" (so a fresh
  // open re-fetches and the search box is empty).
  adminPanel: AdminPanelState;
}

// ---- Phase 09d-2b: admin moderation panel state shapes ---------------
//
// Declared BEFORE initialState because initialState references
// initialAdminPanelState, and TypeScript const declarations must
// be ordered top-to-bottom in the source file.

export type AdminTab = "users" | "blacklist";

// AdminUsersState mirrors what AdminUsersTab needs: the current
// users list, search query, pagination cursor, load + action error
// strings, and the open confirm-modal target (for destructive
// actions). refreshTick bumps to force a re-fetch on the active
// tab; searchPending differentiates "q just changed, debounce the
// fetch" from "page changed, fire immediately".
export interface AdminUsersState {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
  q: string;
  searchPending: boolean;
  refreshTick: number;
  loading: boolean;
  loadError: string | null;
  pendingActionUserID: string | null;
  actionError: string | null;
  confirm: {
    userID: string;
    action: "soft-delete" | "purge";
  } | null;
}

export interface AdminBlacklistState {
  entries: BlacklistEntry[];
  total: number;
  limit: number;
  offset: number;
  refreshTick: number;
  loading: boolean;
  loadError: string | null;
  addForm: { email: string; reason: string };
  addBusy: boolean;
  addError: string | null;
  pendingRemoveEmail: string | null;
  removeError: string | null;
}

export interface AdminPanelState {
  activeTab: AdminTab;
  users: AdminUsersState;
  blacklist: AdminBlacklistState;
}

const initialAdminUsersState: AdminUsersState = {
  users: [],
  total: 0,
  limit: 50,
  offset: 0,
  q: "",
  searchPending: false,
  refreshTick: 0,
  loading: false,
  loadError: null,
  pendingActionUserID: null,
  actionError: null,
  confirm: null,
};

const initialAdminBlacklistState: AdminBlacklistState = {
  entries: [],
  total: 0,
  limit: 50,
  offset: 0,
  refreshTick: 0,
  loading: false,
  loadError: null,
  addForm: { email: "", reason: "" },
  addBusy: false,
  addError: null,
  pendingRemoveEmail: null,
  removeError: null,
};

export const initialAdminPanelState: AdminPanelState = {
  activeTab: "users",
  users: initialAdminUsersState,
  blacklist: initialAdminBlacklistState,
};

export const initialState: AppState = {
  wsState: "connecting",
  wsDetail: "",
  user: null,
  channels: {},
  channelOrder: [],
  activeChannelID: null,
  messages: {},
  historyLoaded: {},
  historyComplete: {},
  unread: {},
  activity: {},
  unreadMarks: {},
  proposals: {},
  voiceRosters: {},
  voiceEnabled: false,
  wrapSigRequired: false,
  recentJoins: {},
  rosterNotices: {},
  serverVersion: "",
  serverCommit: "",
  serverBuildAtLoad: null,
  updateAvailable: false,
  dismissedBuild: null,
  serverRestarting: false,
  friends: [],
  friendsLoaded: false,
  // Phase 9.6a:
  pendingIncoming: [],
  pendingOutgoing: [],
  friendsPanel: initialFriendsPanelState,
  // Phase 9.6b:
  dmPendingForUserID: null,
  // Phase 9.6c:
  presence: {},
  // 92-2:
  lastSeen: {},
  // Phase 9.6j:
  myPresenceMode: "auto",
  myEffectivePresence: "offline",

  // Phase 9.7a:
  prefs: {},
  prefsLoaded: false,

  // Phase 10b:
  openThread: null,

  // 53-1: every session starts parked -- the parking lot is the startup
  // screen, so a reload or restart never opens a conversation on its own.
  parked: true,
  // 53-4: nothing was open before that, so there is nothing to go back to.
  parkedReturn: null,

  // Phase 10c:
  threadMessages: {},
  threadLoaded: {},

  // 37-5:
  reactions: {},

  // Phase 10d:
  threadSeen: {},
  // 42-7: thread inbox.
  threadInboxActive: [],
  threadInboxAgedUnread: [],
  threadInboxLoaded: false,
  threadInboxHasMoreActive: false,
  threadInboxUnreadTotal: 0,
  threadInboxWindowHours: 48,
  threadInboxStale: false,
  threadMentions: {},
  createModalOpen: false,

  // Phase 09b sub-step 4 auth-flow initial values.
  authStage: initialAuthState.authStage,
  authConfig: initialAuthState.authConfig,
  registration: initialAuthState.registration,
  registrationResult: initialAuthState.registrationResult,
  // Phase 09b sub-step 5b additions.
  login: initialAuthState.login,
  me: initialAuthState.me,
  // Phase 09c-2 additions.
  inviteContext: initialAuthState.inviteContext,
  verifyEmailChange: initialAuthState.verifyEmailChange,
  myInvites: initialAuthState.myInvites,
  emailChange: initialAuthState.emailChange,
  openPanel: null,
  profileRefreshing: false,
  // Phase 09d-2a:
  adminClaimUsername: initialAuthState.adminClaimUsername,
  // Phase 09d-2b:
  route: "chat",
  adminPanel: initialAdminPanelState,
};

// ---- Actions -------------------------------------------------------------

export type Action =
  | { kind: "ws_state"; state: ConnectionState; detail?: string }
  | {
      kind: "welcome";
      userID: string;
      deviceID: string;
      handle: string;
      channels: string[];
      voiceEnabled: boolean;
      wrapSigRequired: boolean; // 82-6
      // 39-1: absent on older servers, hence optional.
      serverVersion?: string;
      serverCommit?: string;
    }
  // 46-3: the server announced it is restarting (server_notice/restarting).
  | { kind: "server_restarting" }
  // 46-2: the user waved off the reload pill.
  | { kind: "update_dismissed" }
  | { kind: "channels_loaded"; channels: ChannelSummary[] }
  | { kind: "channel_added"; channel: ChannelSummary }
  | { kind: "channel_removed"; channelID: string }
  // 106-2: the owner renamed the channel and/or changed its short name.
  // Carries only the two names: a channel_event summary is built without
  // a user scope, so folding the whole row would zero the read seed.
  | { kind: "channel_updated"; channelID: string; name: string; shortName: string }
  | { kind: "channel_key_version_updated"; channelID: string; currentKeyVersion: number }
  // ---- Phase 30 (30-4): voice room occupancy --------------------------
  | { kind: "voice_roster_set"; channelID: string; roster: VoiceParticipant[] }
  | { kind: "voice_participant_joined"; channelID: string; userID: string; deviceID: string }
  | { kind: "voice_participant_left"; channelID: string; userID: string; deviceID: string }
  | { kind: "voice_participant_state"; channelID: string; participant: VoiceParticipant }
  // 45-1: the room emptied and the server destroyed the channel's scratchpad.
  // Everything derived from those messages goes with them.
  | { kind: "voice_purged"; channelID: string }
  | { kind: "channel_rotation_pending_set"; channelID: string; pending: boolean }
  // Phase 11c-2 PR 4: optimistic local updates on add/remove member.
  | { kind: "channel_member_added"; channelID: string; userID: string; handle: string }
  // 82-8: dismiss the "who joined" notice for one channel.
  | { kind: "joins_dismissed"; channelID: string }
  // 83-7: the observed-roster diff produced (or reloaded) notices.
  | { kind: "roster_notices_set"; channelID: string; notices: import("../chat/roster-observe").RosterNotice[] }
  | { kind: "roster_notices_dismissed"; channelID: string }
  | { kind: "channel_member_removed"; channelID: string; userID: string }
  | { kind: "set_active_channel"; channelID: string | null }
  // 53-1: park (hide the conversation pane) or leave the parking lot. Picking
  // any channel or thread unparks on its own; this action is the row itself.
  | { kind: "set_parked"; parked: boolean }
  // 53-4: leave the parking lot and put back what parking closed. Distinct from
  // set_parked{parked:false}, which only clears the screen state -- the restore
  // belongs to the boss key, not to every other path out of the lot.
  | { kind: "unpark" }
  // ---- Phase 33: unread + mentions ------------------------------------
  // read_state: the server-synced cursor moved (mark_read ack, or a push
  // from another of this user's devices). Monotonic; clears the mention
  // flag once the cursor catches up to lastSeq.
  | { kind: "read_state"; channelID: string; lastReadSeq: number }
  // mention_set: this client decrypted a message in an unfocused channel
  // that names the user. Derived locally -- see state/mentions.ts.
  | { kind: "mention_set"; channelID: string }
  // unread_mark_refresh: re-capture the frozen unread window for a channel
  // the user is (re-)attending to. Dispatched when the tab regains focus on
  // an already-active channel; the channel-switch path captures it inline.
  | { kind: "unread_mark_refresh"; channelID: string | null }
  | { kind: "message"; message: Message }
  // Server confirmed a send committed: retire the optimistic row identified
  // by clientMsgID, adopting the real server id/seq/ts (or dropping it if the
  // server row already arrived by another path).
  | {
      kind: "send_ack";
      channelID: string;
      clientMsgID: string;
      id: string;
      seq: number;
      ts: Date;
    }
  // Phase 26 (governance prereq): a message was deleted; tombstone it in place.
  | { kind: "message_deleted"; channelID: string; messageID: string; deletedBy?: string; deletedAt?: Date }
  // Phase 37-3: the author replaced a message's body. body is already
  // decrypted by the time this is dispatched, same as the "message" action.
  | {
      kind: "message_edited";
      channelID: string;
      messageID: string;
      body: string;
      keyVersion?: number;
      editedAt: Date;
      // 83-3: verdict + chain state of the opened edit envelope. Absent for
      // a legacy (unsigned) edit -- the reducer then downgrades to unsigned.
      verify?: import("../crypto/envelope").VerifyStatus;
      editHeadHash?: string;
      editPrevRevHash?: string;
      editAncestry?: import("../crypto/revisions").EditAncestry;
    }
  // 83-3: the async revision-chain walk finished for one edited row.
  | {
      kind: "edit_ancestry";
      channelID: string;
      messageID: string;
      ancestry: import("../crypto/revisions").EditAncestry;
      originalHashHex?: string;
    }
  // 37-5: one member's decrypted reaction set for one message changed. An
  // empty emoji array means they cleared their reactions. 83-3: setHashHex
  // carries the signed set envelope's object hash (the actor's next set
  // links to it via prev_set_hash); absent for legacy JSON sets.
  | { kind: "reaction_set"; messageID: string; userID: string; emoji: string[]; setHashHex?: string }
  // 37-5: backfill decrypted sets for a batch of messages after a history
  // fetch. Replaces whatever was cached for each message id present.
  | { kind: "reactions_merged"; byMessageID: Record<string, ReactionSet[]> }
  // 55-1: complete=true when the page came back short (the channel's
  // beginning is loaded). Optional and only ever raises the flag, so the
  // existing dispatch sites and fixtures are unchanged.
  | { kind: "history_loaded"; channelID: string; messages: Message[]; complete?: boolean }
  // att-2: backfill attachment refs onto already-loaded messages, keyed by
  // message id. Used after the channel-open window list query (history fetches
  // don't carry attachments; the live push does).
  | { kind: "attachments_merged"; channelID: string; byMessageID: Record<string, AttachmentRef[]> }
  | { kind: "friends_loaded"; friends: Friend[]; pendingIncoming?: Friend[]; pendingOutgoing?: Friend[] }
  | { kind: "open_create_modal" }
  | { kind: "close_create_modal" }
  // Phase 09c-2: in-chat panel toggles.
  | {
      kind: "open_panel";
      panel:
        | "invites"
        | "profile"
        | "friends"
        | "members"
        | "governance"
        | "threads"
        | "notifications"
        | "search";
    }
  | { kind: "close_panel" }
  // Phase 09c-2: profile-panel refresh (spinner only; the actual
  // identity update arrives via the existing auth_me_loaded action).
  | { kind: "profile_refresh_start" }
  | { kind: "profile_refresh_done" }
  // ---- Phase 09d-2b: admin panel routing + state ------------------
  | { kind: "route_to_admin" }
  | { kind: "route_to_chat" }
  | { kind: "admin_tab_change"; tab: AdminTab }
  // Users tab:
  | { kind: "admin_users_search_change"; q: string }
  | { kind: "admin_users_page_change"; offset: number }
  | { kind: "admin_users_refresh" }
  | { kind: "admin_users_load_start" }
  | {
      kind: "admin_users_load_succeeded";
      users: AdminUser[];
      total: number;
      limit: number;
      offset: number;
    }
  | { kind: "admin_users_load_failed"; message: string }
  | { kind: "admin_users_action_start"; userID: string }
  | {
      kind: "admin_users_action_succeeded";
      userID: string;
      action: "block" | "unblock" | "soft-delete" | "purge";
    }
  | {
      kind: "admin_users_action_failed";
      userID: string;
      action: "block" | "unblock" | "soft-delete" | "purge";
      message: string;
    }
  | { kind: "admin_users_action_error_dismissed" }
  | {
      kind: "admin_users_confirm_open";
      userID: string;
      action: "soft-delete" | "purge";
    }
  | { kind: "admin_users_confirm_close" }
  // Blacklist tab:
  | { kind: "admin_blacklist_page_change"; offset: number }
  | { kind: "admin_blacklist_refresh" }
  | { kind: "admin_blacklist_load_start" }
  | {
      kind: "admin_blacklist_load_succeeded";
      entries: BlacklistEntry[];
      total: number;
      limit: number;
      offset: number;
    }
  | { kind: "admin_blacklist_load_failed"; message: string }
  | {
      kind: "admin_blacklist_add_form_change";
      field: "email" | "reason";
      value: string;
    }
  | { kind: "admin_blacklist_add_start" }
  | { kind: "admin_blacklist_add_succeeded" }
  | { kind: "admin_blacklist_add_failed"; message: string }
  | { kind: "admin_blacklist_add_error_dismissed" }
  | { kind: "admin_blacklist_remove_start"; email: string }
  | { kind: "admin_blacklist_remove_succeeded"; email: string }
  | { kind: "admin_blacklist_remove_failed"; email: string; message: string }
  | { kind: "admin_blacklist_remove_error_dismissed" }
  // ---- Phase 9.6a: friends panel actions -------------------------------
  | { kind: "friends_panel_tab_change"; tab: "add" | "pending" | "friends" }
  | { kind: "friends_add_input_change"; value: string }
  | { kind: "friends_add_clear_error" }
  | { kind: "friends_add_start" }
  | { kind: "friends_add_failed"; error: string }
  | { kind: "friends_add_succeeded" }
  | { kind: "friends_action_start"; userID: string }
  | { kind: "friends_action_done"; userID: string }
  // ---- Phase 9.6b: roster-driven DM creation ---------------------------
  | { kind: "dm_pending_set"; userID: string }
  | { kind: "dm_pending_clear" }
  // ---- Phase 9.6c: presence ---------------------------------------------
  // 92-2: `at` is the push's last-activity stamp, absent when the caller
  // has none (the reducer then leaves lastSeen untouched for that user).
  | { kind: "presence_set"; userID: string; state: string; at?: number }
  | { kind: "presence_clear"; userID: string }
  | { kind: "presence_reset" }
  // ---- Phase 9.6j: manual presence override ---------------------------
  | { kind: "presence_mode_set"; mode: "auto" | "online" | "away" }
  | { kind: "my_effective_presence_set"; state: "online" | "away" | "offline" }
  // ---- Phase 9.7a: preferences -----------------------------------
  // 62-7: a decrypted preview for the channel's newest message, from the
  // warm loop. seq is the seq of the ciphertext that was decrypted; the
  // reducer drops the result unless it still matches activity[channelID]
  // (a live message may have superseded it mid-decrypt).
  | { kind: "channel_preview"; channelID: string; seq: number; preview: string }
  | { kind: "prefs_loaded"; prefs: UserPrefs }
  | { kind: "prefs_merged"; prefs: UserPrefs }
  // ---- Phase 10b: threading -----------------------------------------
  | { kind: "open_thread"; channelID: string; threadID: string }
  | { kind: "close_thread" }
  // ---- Phase 10c: thread message cache --------------------------------
  | { kind: "thread_loaded"; threadID: string; messages: Message[] }
  // ---- Phase 10d: unread tracking ------------------------------------
  | { kind: "thread_seen_bump"; threadID: string; seq: number }
  // ---- Phase 42-4: durable thread cursors ----------------------------
  // Replaces thread_seen_init, which hydrated the whole map from a
  // per-device localStorage blob. Cursors now arrive one at a time, from the
  // server: as the mark_thread_read ack, or as the cross-device push.
  | { kind: "thread_read_state"; threadID: string; lastReadSeq: number }
  // ---- Phase 42-7: the thread inbox ----------------------------------
  | {
      kind: "thread_inbox_loaded";
      active: ThreadInboxRow[];
      agedUnread: ThreadInboxRow[];
      unreadTotal: number;
      hasMoreActive: boolean;
      windowHours: number;
      // true when paging: append to the active list instead of replacing it.
      append: boolean;
    }
  // Fills one channel's decrypted previews in place, once its key has settled.
  | {
      kind: "thread_inbox_previews";
      channelID: string;
      previews: Record<string, { headBody?: string; lastReplyBody?: string }>;
    }
  | { kind: "thread_mention_set"; threadID: string }
  // One action for what set_active_channel + open_thread would do in two.
  // Necessary, not cosmetic: set_active_channel clears openThread, so two
  // dispatches only work by ordering luck.
  | { kind: "open_thread_from_inbox"; channelID: string; threadID: string }
  // ---- gov-2: governance ---------------------------------------------
  | { kind: "governance_mode_changed"; channelID: string; mode: string }
  | { kind: "proposals_loaded"; channelID: string; proposals: ProposalView[] }
  | { kind: "proposal_opened"; channelID: string; proposal: ProposalView }
  | { kind: "proposal_updated"; channelID: string; proposal: ProposalView }
  | { kind: "proposal_resolved"; channelID: string; proposal: ProposalView }
  | AuthAction;

// Phase 10b: resolve the thread head's id from any message in (or
// starting) a thread.
//   - if the message is already a reply (threadID set), return that.
//   - otherwise, the message IS the head: return its own id.
export function resolveThreadID(msg: { id: string; threadID?: string }): string {
  return msg.threadID ?? msg.id;
}
