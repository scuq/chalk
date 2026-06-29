// chalk SPA -- auth state types.
//
// Phase 09b sub-step 5b: full session-aware auth flow.
//
// State machine:
//
//   bootstrapping ─── (fetch /me)
//        │
//        ├─── 200 (already logged in) ─────────────────────────▶ authed
//        │
//        ├─── 401 (no session) ────▶ login ◀───────┐
//        │                              │           │
//        │                              ▼           │ ("no account?
//        │                          (submit         │   register" link)
//        │                           login          │
//        │                           ceremony)      │
//        │                              │           │
//        │                              ▼           │
//        │                            authed        │
//        │                                          │
//        └─── (user clicks "register" link) ──▶ registering ──┘
//                                                  │
//                                                  ▼ (submit)
//                                          (register ceremony,
//                                           register/finish
//                                           Set-Cookies)
//                                                  │
//                                                  ▼
//                                          confirming-recovery
//                                                  │
//                                                  ▼ (clicks continue)
//                                                authed
//
// Notable changes from 09b-4:
//   - "transitional-handoff" stage is GONE. register/finish now
//     Set-Cookies, so after confirming recovery we go straight to
//     authed.
//   - "login" stage added. AuthGate renders LoginScreen here.
//   - "bootstrapping" now fetches /api/auth/me. The /me response
//     decides login vs authed. AuthConfig is fetched lazily by the
//     screen that needs it (RegisterScreen reads it for the dev/open
//     badges).

// AuthStage drives which screen renders. authed = show chat.
//
// Phase 09c-2 adds two new "URL-driven" stages:
//   - registering-from-invite: user landed at /?invite=<token>
//     AuthGate peeks the invite, pre-fills email + inviter info,
//     and renders RegisterFromInviteScreen. On success goes to
//     confirming-recovery (same as ordinary registration).
//   - verifying-email-change: user landed at /?verify_email=<token>
//     AuthGate calls /api/auth/verify-email-change/{token} on mount
//     and renders VerifyEmailChangeScreen with success/error UX.
//     Independent of session state (the token alone authorizes the
//     verify call; a logged-out user can also complete it).
export type AuthStage =
  | "bootstrapping"
  | "login"
  | "registering"
  | "registering-from-invite"
  | "verifying-email-change"
  | "confirming-recovery"
  | "recovery-login"
  | "regenerate-after-recovery"
  | "offer-passkey-after-recovery"
  | "admin-bootstrap"
  | "authed";

// AuthConfig mirrors the GET /api/auth/config response body. See
// internal/auth/http.go::configResponse for the wire shape.
export interface AuthConfig {
  rp_id: string;
  rp_name: string;
  open_registration: boolean;
  dev_mode: boolean;
  recovery_word_count: number;
  // att-4: whether the server has a Giphy API key configured. The composer
  // Giphy button is shown only when true. Per-user consent (prefs.giphy) is
  // separate and gates whether the picker/search actually run.
  giphy_enabled: boolean;
}

// RegistrationForm is the SPA-side draft state of the registration
// form. Lives in the reducer so re-renders preserve typing.
export interface RegistrationForm {
  username: string;
  displayName: string;
  email: string;
  inviteToken: string;
  showAdvanced: boolean;
  busy: boolean;
  // error is set when the most recent submit attempt failed. The
  // server's error code drives field-level vs general placement;
  // RegisterScreen branches on errorCode to render inline.
  errorCode: string | null;
  errorMessage: string | null;
}

export const initialRegistrationForm: RegistrationForm = {
  username: "",
  displayName: "",
  email: "",
  inviteToken: "",
  showAdvanced: false,
  busy: false,
  errorCode: null,
  errorMessage: null,
};

// LoginForm: SPA-side draft state of the login form.
export interface LoginForm {
  username: string;
  busy: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export const initialLoginForm: LoginForm = {
  username: "",
  busy: false,
  errorCode: null,
  errorMessage: null,
};

// RecoveryLoginForm: SPA-side draft state of the recovery login form.
// `phrase` holds the raw text the user types/pastes; we normalize at
// submit time. busy/error mirror LoginForm.
export interface RecoveryLoginForm {
  username: string;
  phrase: string;
  busy: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export const initialRecoveryLoginForm: RecoveryLoginForm = {
  username: "",
  phrase: "",
  busy: false,
  errorCode: null,
  errorMessage: null,
};

// RegistrationResult: what register/finish returned. Held for the
// duration of the recovery screen so the user can see their identity
// AND copy the words. After auth_recovery_confirmed it's cleared
// (the words MUST NOT linger in state any longer).
//
// sessionExpiresAt is the cookie's TTL boundary, useful for UI
// "your session expires in X days" copy.
export interface RegistrationResult {
  userID: string;
  username: string;
  displayName: string;
  recoveryWords: string[];
  sessionExpiresAt: string;
}

// LoginResult: what authenticate/finish returned. Cookie is set by
// the server in the response headers; the SPA never sees the raw
// token, just the identity for display purposes.
export interface LoginResult {
  userID: string;
  username: string;
  displayName: string;
  role: string;
  sessionExpiresAt: string;
}

// RecoveryLoginResult: what /api/auth/recovery returned. Same identity
// shape as LoginResult plus regenerateRequired. In 09b-6 the latter is
// always true; future flows might set it false (e.g. if a user is
// going through recovery merely to rotate words proactively from a
// settings page).
export interface RecoveryLoginResult {
  userID: string;
  username: string;
  displayName: string;
  role: string;
  sessionExpiresAt: string;
  regenerateRequired: boolean;
}

// MeResponse: GET /api/auth/me when a valid session exists. Mirrors
// the server's meResponse shape.
export interface MeResponse {
  userID: string;
  username: string;
  displayName: string;
  role: string;
  email: string;
  emailVerifiedAt: string; // zero value: "0001-01-01T00:00:00Z"
  sessionExpiresAt: string;
}

// AuthState is the auth-related slice of AppState. It's spread into
// AppState so existing reducers keep working without restructuring.
export interface AuthState {
  authStage: AuthStage;
  authConfig: AuthConfig | null;
  registration: RegistrationForm;
  registrationResult: RegistrationResult | null;
  login: LoginForm;
  // me holds the resolved identity once the user is authed. Drives
  // StatusBar display, app title bar, future settings panel. Null
  // when not authed.
  me: MeResponse | null;
  // Sub-step 6: recovery login form + pending regenerate state.
  recoveryLogin: RecoveryLoginForm;
  // pendingRegenerateWords is the new 24-word phrase returned by
  // /recovery/regenerate. Held only for the duration of the
  // RegenerateScreen; cleared on confirm. Null at all other times.
  pendingRegenerateWords: string[] | null;
  // Phase 09c-2 additions:
  inviteContext: InviteContext | null;
  verifyEmailChange: VerifyEmailChangeState | null;
  myInvites: MyInvitesState;
  emailChange: EmailChangeState;
  // Phase 09d-2a: first-run admin enrollment driven by
  // ?admin_bootstrap=<token>. Populated by AuthGate when it sees the
  // URL param; cleared on success (auth_registered also clears it
  // so a stale token does not linger in state) or on dismiss.
  adminBootstrap: AdminBootstrapState | null;
}

// InviteContext holds the parsed ?invite=<token> URL parameter +
// the result of the peek call. Populated by AuthGate at bootstrap
// when the URL contains the param; consumed by
// RegisterFromInviteScreen. Cleared on auth_invite_context_cleared
// (the user dismissed the invite-driven flow) or on successful
// registration.
//
// peekStatus mirrors the server's "active" | "used" | "revoked" |
// "expired", plus the SPA-only "loading" (peek in flight) and
// "error" (peek failed -- token malformed or server unreachable).
// The RegisterFromInviteScreen branches on this to render the
// right UX: "active" → the actual form; others → an explanatory
// screen with a "register normally" or "back to login" escape.
export interface InviteContext {
  token: string;
  peekStatus: "loading" | "active" | "used" | "revoked" | "expired" | "error";
  // Populated once the peek call returns. Null while loading and
  // on most error cases.
  peek: PeekedInvite | null;
  // For peekStatus === "error". Empty string in success cases.
  errorMessage: string;
}

// PeekedInvite mirrors the server's peekInviteResponse plus the
// status field which is also in the wire body.
export interface PeekedInvite {
  email: string;
  inviterUsername: string;
  expiresAt: string;
}

// VerifyEmailChangeState drives VerifyEmailChangeScreen. Populated
// at bootstrap when ?verify_email=<token> is in the URL. The screen
// fires the verify call on mount and transitions through these
// states:
//   loading → success | failure
// `newEmail` is filled on success (from the server response) so
// the success copy can say "your email is now X".
export interface VerifyEmailChangeState {
  token: string;
  phase: "loading" | "success" | "failure";
  newEmail: string; // populated on success
  errorCode: string;
  errorMessage: string;
}

// Phase 09d-2a: AdminBootstrapState drives AdminBootstrapScreen.
// Populated by AuthGate when ?admin_bootstrap=<token> is in the URL.
// Simpler than InviteContext: no separate peek step, the token is
// validated on the /bootstrap/begin call itself. Busy + errorCode +
// errorMessage track the in-flight WebAuthn ceremony so the screen
// can disable its submit button and surface server errors.
export interface AdminBootstrapState {
  token: string;
  busy: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

// MyInvitesState drives InvitesPanel. Holds the list of invites
// the user has issued plus the create-invite form state.
export interface MyInvitesState {
  // List of invites, newest-first per the server response. Null
  // means "not yet fetched"; empty array means "fetched, no invites".
  items: import("./api").InviteDTO[] | null;
  loading: boolean;
  // Top-level error (e.g. listing failed). Field-level errors on
  // create/revoke live in createForm.errorCode / lastRevokeError.
  loadError: string | null;

  // Create-invite form:
  createForm: {
    email: string;
    note: string;
    busy: boolean;
    errorCode: string | null;
    errorMessage: string | null;
  };

  // The token currently being revoked, if any. Used to disable just
  // the affected row's revoke button. Null when no revoke is in
  // flight. revokeError carries the most recent failure (if the
  // request failed) so the row can render a small inline message.
  revokingToken: string | null;
  revokeError: { token: string; code: string; message: string } | null;
}

export const initialMyInvitesState: MyInvitesState = {
  items: null,
  loading: false,
  loadError: null,
  createForm: {
    email: "",
    note: "",
    busy: false,
    errorCode: null,
    errorMessage: null,
  },
  revokingToken: null,
  revokeError: null,
};

// EmailChangeState drives the change-email form inside ProfilePanel.
// Distinct from VerifyEmailChangeState (which handles the click-
// the-link side); this is the "I want to start a change" side.
//
// After a successful submit, `pendingSummary` is populated so the
// panel can render "we sent a verification email to X. Click the
// link there to complete the change. Expires at Y." until the user
// either dismisses the panel or completes the verify (which the
// SPA learns about on the next /me refresh, not via WS).
export interface EmailChangeState {
  draft: string;            // text in the input field
  busy: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  // pendingSummary is set on a successful start. Held until panel
  // close + reopen, or user starts another change.
  pendingSummary: {
    newEmail: string;
    expiresAt: string;
  } | null;
}

export const initialEmailChangeState: EmailChangeState = {
  draft: "",
  busy: false,
  errorCode: null,
  errorMessage: null,
  pendingSummary: null,
};

export const initialAuthState: AuthState = {
  authStage: "bootstrapping",
  authConfig: null,
  registration: initialRegistrationForm,
  registrationResult: null,
  login: initialLoginForm,
  me: null,
  recoveryLogin: initialRecoveryLoginForm,
  pendingRegenerateWords: null,
  inviteContext: null,
  verifyEmailChange: null,
  myInvites: initialMyInvitesState,
  emailChange: initialEmailChangeState,
  adminBootstrap: null,
};

// AuthAction is the union of all auth-related reducer actions.
// Kept in its own type so we can compose with AppState's Action.
export type AuthAction =
  | { kind: "auth_config_loaded"; config: AuthConfig }
  | { kind: "auth_config_failed"; message: string }
  // Registration:
  | { kind: "auth_form_change"; field: keyof RegistrationForm; value: string | boolean }
  | { kind: "auth_form_submit_start" }
  | { kind: "auth_form_submit_error"; code: string; message: string }
  | { kind: "auth_registered"; result: RegistrationResult }
  | { kind: "auth_recovery_confirmed" }
  // Login:
  | { kind: "auth_login_form_change"; field: keyof LoginForm; value: string }
  | { kind: "auth_login_submit_start" }
  | { kind: "auth_login_submit_error"; code: string; message: string }
  | { kind: "auth_logged_in"; result: LoginResult }
  // Session bootstrap + teardown:
  | { kind: "auth_me_loaded"; me: MeResponse }
  | { kind: "auth_me_absent" }
  | { kind: "auth_logged_out" }
  // Navigation:
  | { kind: "auth_go_register" }
  | { kind: "auth_go_login" }
  // Sub-step 6: recovery login:
  | { kind: "auth_go_recovery" }
  | { kind: "auth_recovery_login_form_change"; field: keyof RecoveryLoginForm; value: string }
  | { kind: "auth_recovery_login_submit_start" }
  | { kind: "auth_recovery_login_submit_error"; code: string; message: string }
  | { kind: "auth_recovered"; result: RecoveryLoginResult }
  | { kind: "auth_regenerate_words_loaded"; words: string[] }
  | { kind: "auth_regenerate_confirmed" }
  | { kind: "auth_passkey_offer_done" }
  // ---- phase 09c-2: invites + email change -------------------------
  // URL-driven flows:
  | { kind: "auth_invite_detected"; token: string }
  | { kind: "auth_invite_peek_loaded"; peek: PeekedInvite; status: "active" | "used" | "revoked" | "expired" }
  | { kind: "auth_invite_peek_failed"; code: string; message: string }
  | { kind: "auth_invite_dismissed" } // user clicked "register normally" or similar
  | { kind: "auth_verify_email_detected"; token: string }
  | { kind: "auth_verify_email_succeeded"; userID: string; newEmail: string }
  | { kind: "auth_verify_email_failed"; code: string; message: string }
  | { kind: "auth_verify_email_dismissed" }
  // InvitesPanel (in-chat) - listing + create + revoke:
  | { kind: "invites_load_start" }
  | { kind: "invites_load_succeeded"; items: import("./api").InviteDTO[] }
  | { kind: "invites_load_failed"; message: string }
  | { kind: "invites_create_form_change"; field: "email" | "note"; value: string }
  | { kind: "invites_create_submit_start" }
  | { kind: "invites_create_submit_error"; code: string; message: string }
  | { kind: "invites_create_submit_succeeded"; invite: import("./api").InviteDTO }
  | { kind: "invites_revoke_start"; token: string }
  | { kind: "invites_revoke_succeeded"; token: string }
  | { kind: "invites_revoke_failed"; token: string; code: string; message: string }
  | { kind: "invites_revoke_error_cleared" }
  // ProfilePanel (in-chat) - change-email form:
  | { kind: "email_change_draft_change"; value: string }
  | { kind: "email_change_submit_start" }
  | { kind: "email_change_submit_error"; code: string; message: string }
  | { kind: "email_change_submit_succeeded"; newEmail: string; expiresAt: string }
  | { kind: "email_change_dismissed" }
  // me-mutation: after verify-email-change succeeds, refresh /me
  // copy locally so the ProfilePanel updates without an extra
  // round-trip. Used by both the VerifyEmailChangeScreen success
  // path AND the in-chat panel if the user verifies in another tab.
  | { kind: "auth_me_email_updated"; newEmail: string }
  // Phase 09d-2a: admin bootstrap (URL-driven first-run enrollment).
  // detected   — AuthGate parsed ?admin_bootstrap=<token>; transition
  //              to the "admin-bootstrap" stage.
  // submit_start / submit_error — drive the busy + error UI on
  //              AdminBootstrapScreen during the WebAuthn ceremony.
  // dismissed  — user clicked "go to login" after a terminal error
  //              (admin_already_enrolled etc.); clear state, go to
  //              login.
  // (Success transitions through auth_registered → confirming-recovery,
  // reusing the registration flow.)
  | { kind: "auth_admin_bootstrap_detected"; token: string }
  | { kind: "auth_admin_bootstrap_submit_start" }
  | { kind: "auth_admin_bootstrap_submit_error"; code: string; message: string }
  | { kind: "auth_admin_bootstrap_dismissed" };
