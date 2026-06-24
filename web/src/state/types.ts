// State types for the chalk SPA.
//
// Phase 08b extracts these from App.tsx because the state shape is now
// non-trivial: per-channel message arrays, channel list, active channel
// pointer, history-loaded markers, modal visibility.
//
// All shapes mirror proto.ts wire types but with client-side conveniences
// added (e.g. ChannelSummary's createdAt as Date, Message's ts as Date).

import type { ConnectionState } from "../ws-client";
import type { AttachmentRef } from "../attachments/types";
import type {
  AdminBootstrapState,
  AuthAction,
  AuthConfig,
  AuthStage,
  EmailChangeState,
  InviteContext,
  LoginForm,
  MeResponse,
  MyInvitesState,
  RecoveryLoginForm,
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
  // att-2: encrypted attachments linked to this message. Populated from the
  // live push (wireToMessage) and backfilled for history via the window list
  // query (attachments_merged). Undefined/empty for the common text message.
  attachments?: AttachmentRef[];
}

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
}

export interface UserPrefs {
  // Phase 9.7b: theme name. "green" = default terminal theme.
  // Other valid values: "light", "cyberpunk", "solarized-dark".
  theme?: string;
  // Phase 9.7d: chat-display sub-prefs.
  chat?: ChatPrefs;
  // [extend with more keys in future phases]
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
  };
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

  // gov-2: governance proposals by channel id (open + recently resolved).
  proposals: Record<string, ProposalView[]>;

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

  // Phase 10c: thread message caches.
  //   threadMessages[threadID] is the list of replies for that thread,
  //   in seq order (oldest first). The thread head itself is NOT here;
  //   the panel reads it from the channel cache.
  //   threadLoaded[threadID] is true once fetch_thread_ack arrived for
  //   that thread; the panel uses it to distinguish "loading" from
  //   "empty thread" (latter shouldn't happen but the rendering is
  //   robust either way).
  threadMessages: Record<string, Message[]>;
  threadLoaded: Record<string, boolean>;

  // Phase 10d: highest reply seq the user has "seen" per thread,
  // used to compute unread badges. Persisted to localStorage per
  // user. A reply with seq > threadSeen[threadID] counts as unread.
  threadSeen: Record<string, number>;
  friendsLoaded: boolean;

  // UI.
  createModalOpen: boolean;

  // Phase 09b sub-step 4: auth-flow state. Spread from AuthState
  // for typing convenience but kept conceptually separate. See
  // src/auth/types.ts for the full shape and stage diagram.
  // Sub-step 5b adds login form state and the /me identity.
  // Sub-step 6 adds the recovery login form and pending regenerate words.
  authStage: AuthStage;
  authConfig: AuthConfig | null;
  registration: RegistrationForm;
  registrationResult: RegistrationResult | null;
  login: LoginForm;
  me: MeResponse | null;
  recoveryLogin: RecoveryLoginForm;
  pendingRegenerateWords: string[] | null;

  // Phase 09c-2 auth state:
  inviteContext: InviteContext | null;
  verifyEmailChange: VerifyEmailChangeState | null;
  myInvites: MyInvitesState;
  emailChange: EmailChangeState;
  // Phase 09d-2a: first-run admin enrollment via URL param.
  adminBootstrap: AdminBootstrapState | null;

  // Phase 09c-2 UI: which in-chat panel is open (if any).
  // null = no panel. "invites" → InvitesPanel modal.
  // "profile" → ProfilePanel modal. Mutually exclusive with
  // createModalOpen (only one modal-equivalent at a time).
  openPanel: "invites" | "profile" | "friends" | "members" | "governance" | null;
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
  proposals: {},
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
  // Phase 9.6j:
  myPresenceMode: "auto",
  myEffectivePresence: "offline",

  // Phase 9.7a:
  prefs: {},
  prefsLoaded: false,

  // Phase 10b:
  openThread: null,

  // Phase 10c:
  threadMessages: {},
  threadLoaded: {},

  // Phase 10d:
  threadSeen: {},
  createModalOpen: false,

  // Phase 09b sub-step 4 auth-flow initial values.
  authStage: initialAuthState.authStage,
  authConfig: initialAuthState.authConfig,
  registration: initialAuthState.registration,
  registrationResult: initialAuthState.registrationResult,
  // Phase 09b sub-step 5b additions.
  login: initialAuthState.login,
  me: initialAuthState.me,
  // Phase 09b sub-step 6 additions.
  recoveryLogin: initialAuthState.recoveryLogin,
  pendingRegenerateWords: initialAuthState.pendingRegenerateWords,
  // Phase 09c-2 additions.
  inviteContext: initialAuthState.inviteContext,
  verifyEmailChange: initialAuthState.verifyEmailChange,
  myInvites: initialAuthState.myInvites,
  emailChange: initialAuthState.emailChange,
  openPanel: null,
  profileRefreshing: false,
  // Phase 09d-2a:
  adminBootstrap: initialAuthState.adminBootstrap,
  // Phase 09d-2b:
  route: "chat",
  adminPanel: initialAdminPanelState,
};

// ---- Actions -------------------------------------------------------------

export type Action =
  | { kind: "ws_state"; state: ConnectionState; detail?: string }
  | { kind: "welcome"; userID: string; deviceID: string; handle: string; channels: string[] }
  | { kind: "channels_loaded"; channels: ChannelSummary[] }
  | { kind: "channel_added"; channel: ChannelSummary }
  | { kind: "channel_removed"; channelID: string }
  | { kind: "channel_key_version_updated"; channelID: string; currentKeyVersion: number }
  | { kind: "channel_rotation_pending_set"; channelID: string; pending: boolean }
  // Phase 11c-2 PR 4: optimistic local updates on add/remove member.
  | { kind: "channel_member_added"; channelID: string; userID: string; handle: string }
  | { kind: "channel_member_removed"; channelID: string; userID: string }
  | { kind: "set_active_channel"; channelID: string | null }
  | { kind: "message"; message: Message }
  // Phase 26 (governance prereq): a message was deleted; tombstone it in place.
  | { kind: "message_deleted"; channelID: string; messageID: string; deletedBy?: string; deletedAt?: Date }
  | { kind: "history_loaded"; channelID: string; messages: Message[] }
  // att-2: backfill attachment refs onto already-loaded messages, keyed by
  // message id. Used after the channel-open window list query (history fetches
  // don't carry attachments; the live push does).
  | { kind: "attachments_merged"; channelID: string; byMessageID: Record<string, AttachmentRef[]> }
  | { kind: "friends_loaded"; friends: Friend[]; pendingIncoming?: Friend[]; pendingOutgoing?: Friend[] }
  | { kind: "open_create_modal" }
  | { kind: "close_create_modal" }
  // Phase 09c-2: in-chat panel toggles.
  | { kind: "open_panel"; panel: "invites" | "profile" | "friends" | "members" | "governance" }
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
  | { kind: "presence_set"; userID: string; state: string }
  | { kind: "presence_clear"; userID: string }
  | { kind: "presence_reset" }
  // ---- Phase 9.6j: manual presence override ---------------------------
  | { kind: "presence_mode_set"; mode: "auto" | "online" | "away" }
  | { kind: "my_effective_presence_set"; state: "online" | "away" | "offline" }
  // ---- Phase 9.7a: preferences -----------------------------------
  | { kind: "prefs_loaded"; prefs: UserPrefs }
  | { kind: "prefs_merged"; prefs: UserPrefs }
  // ---- Phase 10b: threading -----------------------------------------
  | { kind: "open_thread"; channelID: string; threadID: string }
  | { kind: "close_thread" }
  // ---- Phase 10c: thread message cache --------------------------------
  | { kind: "thread_loaded"; threadID: string; messages: Message[] }
  // ---- Phase 10d: unread tracking ------------------------------------
  | { kind: "thread_seen_bump"; threadID: string; seq: number }
  | { kind: "thread_seen_init"; seen: Record<string, number> }
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
