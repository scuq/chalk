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
  AuthAction,
  AuthConfig,
  AuthStage,
  RegistrationForm,
  RegistrationResult,
} from "../auth/types";
import { initialAuthState } from "../auth/types";

// ---- Domain types --------------------------------------------------------

export interface Message {
  id: string;
  channelID: string;
  seq: number;
  sender: string; // device_id; empty for purged-user messages
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
  friendsLoaded: boolean;

  // UI.
  createModalOpen: boolean;

  // Phase 09b sub-step 4: auth-flow state. Spread from AuthState
  // for typing convenience but kept conceptually separate. See
  // src/auth/types.ts for the full shape and stage diagram.
  authStage: AuthStage;
  authConfig: AuthConfig | null;
  registration: RegistrationForm;
  registrationResult: RegistrationResult | null;
}

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
  createModalOpen: false,

  // Phase 09b sub-step 4 auth-flow initial values.
  authStage: initialAuthState.authStage,
  authConfig: initialAuthState.authConfig,
  registration: initialAuthState.registration,
  registrationResult: initialAuthState.registrationResult,
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
  | { kind: "friends_loaded"; friends: Friend[] }
  | { kind: "open_create_modal" }
  | { kind: "close_create_modal" }
  | AuthAction;
