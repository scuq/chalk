// State types for the chalk SPA.
//
// Phase 08b extracts these from App.tsx because the state shape is now
// non-trivial: per-channel message arrays, channel list, active channel
// pointer, history-loaded markers, modal visibility.
//
// All shapes mirror proto.ts wire types but with client-side conveniences
// added (e.g. ChannelSummary's createdAt as Date, Message's ts as Date).

import type { ConnectionState } from "../ws-client";
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
  openPanel: "invites" | "profile" | "friends" | null;
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
  | { kind: "set_active_channel"; channelID: string | null }
  | { kind: "message"; message: Message }
  | { kind: "history_loaded"; channelID: string; messages: Message[] }
  | { kind: "friends_loaded"; friends: Friend[]; pendingIncoming?: Friend[]; pendingOutgoing?: Friend[] }
  | { kind: "open_create_modal" }
  | { kind: "close_create_modal" }
  // Phase 09c-2: in-chat panel toggles.
  | { kind: "open_panel"; panel: "invites" | "profile" | "friends" }
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
  | AuthAction;
