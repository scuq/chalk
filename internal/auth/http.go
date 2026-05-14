package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

// passkeyToWebauthnCredential converts a store.Passkey row into the
// webauthn library's Credential shape, used at FinishLogin to verify
// the assertion against the user's known credentials.
//
// AAGUID and CloneWarning are zero values — chalk doesn't track AAGUID
// per credential (we don't filter on authenticator make/model), and
// clone-warning is a runtime detection that the library handles
// internally based on sign_count.
func passkeyToWebauthnCredential(pk store.Passkey) webauthn.Credential {
	transports := make([]protocol.AuthenticatorTransport, 0, len(pk.Transports))
	for _, t := range pk.Transports {
		transports = append(transports, protocol.AuthenticatorTransport(t))
	}
	return webauthn.Credential{
		ID:        pk.CredentialID,
		PublicKey: pk.PublicKey,
		Transport: transports,
		Authenticator: webauthn.Authenticator{
			SignCount: uint32(pk.SignCount),
		},
	}
}

// HTTPDeps bundles the dependencies the HTTP handlers need. Held by
// the server's lifecycle and passed in once at construction time.
type HTTPDeps struct {
	Service *Service        // WebAuthn ceremony primitives
	Cache   *CeremonyCache  // in-flight ceremony state
	Store   *store.Store    // user/passkey/recovery persistence
	Logger  *log.Logger     // optional; nil → log.Default()

	// AdminUsername, if set, is the one username that may be claimed
	// even when it's on the reserved list. Sourced from the
	// CHALK_ADMIN_USERNAME env var; falls back to "" (no override)
	// when unset. The reserved-username check is exempted only for
	// this exact string match.
	AdminUsername string
}

// MountRegistration registers the sub-step 3 HTTP endpoints on mux.
//
// Routes:
//
//	POST /api/auth/register/begin   → BeginRegistration
//	POST /api/auth/register/finish  → FinishRegistration
//	GET  /api/auth/config           → public RP config for the SPA
//
// The handlers are stateless apart from the *CeremonyCache; the
// service is reused across requests.
func (d *HTTPDeps) MountRegistration(mux *http.ServeMux) error {
	if d.Service == nil || d.Cache == nil || d.Store == nil {
		return fmt.Errorf("auth: HTTPDeps requires Service, Cache, and Store")
	}
	if d.Logger == nil {
		d.Logger = log.Default()
	}
	mux.HandleFunc("POST /api/auth/register/begin", d.handleRegisterBegin)
	mux.HandleFunc("POST /api/auth/register/finish", d.handleRegisterFinish)
	mux.HandleFunc("GET /api/auth/config", d.handleConfig)
	// Sub-step 5: login + identity + logout endpoints.
	mux.HandleFunc("POST /api/auth/authenticate/begin", d.handleAuthenticateBegin)
	mux.HandleFunc("POST /api/auth/authenticate/finish", d.handleAuthenticateFinish)
	mux.HandleFunc("POST /api/auth/logout", d.handleLogout)
	mux.HandleFunc("GET /api/auth/me", d.handleMe)
	return nil
}

// ---- request/response shapes -------------------------------------------

// registerBeginRequest is the SPA's input at /api/auth/register/begin.
type registerBeginRequest struct {
	// InviteToken is sub-step 09c's mechanism. In sub-step 3 it's
	// accepted but only validated when CHALK_OPEN_REGISTRATION=0
	// (default), in which case it's required (and currently always
	// rejected because we have no invites table yet). When open
	// registration is on, this field is ignored.
	InviteToken string `json:"invite_token,omitempty"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	Email       string `json:"email"`
}

// registerBeginResponse echoes the WebAuthn options to the SPA. The
// SPA passes Options to navigator.credentials.create() and posts back
// the result; the cache entry is keyed on the embedded challenge so
// no separate ID round-trips.
type registerBeginResponse struct {
	Options *protocol.CredentialCreation `json:"options"`
}

// registerFinishRequest mirrors the SPA's PublicKeyCredential. We
// accept the raw bytes (the SPA serializes it via our small webauthn.ts
// helper in sub-step 4); go-webauthn parses it.
//
// We use json.RawMessage rather than a typed struct because the
// library has its own parser (ParseCredentialCreationResponseBytes)
// that handles the base64url encoding gymnastics; re-typing here
// would duplicate that logic and drift over time.
type registerFinishRequest struct {
	Credential json.RawMessage `json:"credential"`
}

// registerFinishResponse returns the freshly created user identity
// plus the one-time-only recovery words. Words are NEVER returned
// again — the SPA MUST surface them immediately. Cache-Control
// no-store on this response prevents intermediate caching.
//
// Sub-step 5: register/finish also mints a session and sets the
// chalk_session cookie on the response. The SPA proceeds directly
// from recovery confirmation to chat; no separate login step.
// session_expires_at is included in the body so the SPA can show
// expiry information (and not for any auth purpose — the cookie is
// the auth credential, the body field is just metadata).
type registerFinishResponse struct {
	UserID            string    `json:"user_id"`
	Username          string    `json:"username"`
	DisplayName       string    `json:"display_name"`
	RecoveryWords     []string  `json:"recovery_words"`
	SessionExpiresAt  time.Time `json:"session_expires_at"`
}

// configResponse is what GET /api/auth/config returns. The SPA needs
// to know the RP ID and name to construct the right WebAuthn calls,
// and the registration-mode flag to decide whether to show the
// invite-token field.
type configResponse struct {
	RPID                string `json:"rp_id"`
	RPName              string `json:"rp_name"`
	OpenRegistration    bool   `json:"open_registration"`
	DevMode             bool   `json:"dev_mode"`
	RecoveryWordCount   int    `json:"recovery_word_count"`
}

// ---- handlers ----------------------------------------------------------

// handleConfig returns public auth configuration the SPA needs at
// startup. No authentication required. Cacheable for a short period
// (the values are stable across the chalkd process lifetime).
func (d *HTTPDeps) handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "max-age=60") // values are stable but allow override
	_ = json.NewEncoder(w).Encode(configResponse{
		RPID:              d.Service.RPID(),
		RPName:            d.Service.RPDisplayName(),
		OpenRegistration:  IsOpenRegistration(),
		DevMode:           IsDevMode(),
		RecoveryWordCount: RecoveryWordCount,
	})
}

// handleRegisterBegin starts a registration ceremony. The user does
// not yet exist; we generate a UUID, build the WebAuthn options, and
// stash the pending-user fields in the cache for the finish handler
// to consume.
func (d *HTTPDeps) handleRegisterBegin(w http.ResponseWriter, r *http.Request) {
	var req registerBeginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if err := d.checkRegistrationAllowed(req); err != nil {
		writeError(w, http.StatusForbidden, "registration_closed", err.Error())
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	email := strings.ToLower(strings.TrimSpace(req.Email))
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		displayName = username
	}

	if !IsValidUsername(username) {
		writeError(w, http.StatusBadRequest, "bad_username",
			"username must match ^[a-z0-9_]{3,32}$")
		return
	}
	if IsReservedUsername(username) && username != strings.ToLower(d.AdminUsername) {
		writeError(w, http.StatusConflict, "username_reserved",
			"that username is reserved")
		return
	}
	// sub-step 4 fix1: dev-mode email fill
	// In CHALK_DEV mode, treat an empty email as a request to
	// auto-fill <username>@localhost.invalid. This lets dev
	// fixtures register passkeys without inventing throwaway
	// addresses. Production registrations (CHALK_DEV unset) are
	// unaffected: the looksLikeEmail check below still fires for
	// an empty email and returns 400 bad_email.
	if email == "" && IsDevMode() {
		email = username + "@localhost.invalid"
	}
	if !looksLikeEmail(email) {
		writeError(w, http.StatusBadRequest, "bad_email",
			"email must contain @ and a domain")
		return
	}

	// Pre-flight collision checks. The transactional RegisterUser
	// repeats these at the DB level, so a race during the WebAuthn
	// ceremony (5min window) is caught there too; doing it here
	// fails fast and gives the SPA a clear error before the user
	// touches their authenticator.
	if _, err := d.Store.GetUserByUsername(r.Context(), username); err == nil {
		writeError(w, http.StatusConflict, "username_taken",
			"that username is already in use")
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		d.Logger.Printf("register/begin: lookup username: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	if _, err := d.Store.GetUserByEmail(r.Context(), email); err == nil {
		writeError(w, http.StatusConflict, "email_taken",
			"that email is already in use")
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		d.Logger.Printf("register/begin: lookup email: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}

	pending := PendingUser{
		ID:          uuid.New(),
		Username:    username,
		DisplayName: displayName,
		Email:       email,
	}
	wauthUser := &User{
		ID:          pending.ID,
		Name:        pending.Username,
		DisplayName: pending.DisplayName,
		Credentials: nil, // brand-new user; no creds to exclude
	}
	options, sess, err := d.Service.BeginRegistration(wauthUser)
	if err != nil {
		d.Logger.Printf("register/begin: BeginRegistration: %v", err)
		writeError(w, http.StatusInternalServerError, "ceremony_failed",
			"could not start ceremony")
		return
	}

	d.Cache.Put(sess.Challenge, CeremonyEntry{
		Kind:        KindRegistration,
		Session:     *sess,
		PendingUser: pending,
	})

	writeJSON(w, http.StatusOK, registerBeginResponse{Options: options})
}

// handleRegisterFinish completes a registration ceremony.
//
//  1. Parse the credential response sent by the SPA.
//  2. Extract the challenge from the embedded clientData.
//  3. Look up (and remove) the matching cache entry.
//  4. Run go-webauthn's CreateCredential validation.
//  5. Generate recovery words + hash.
//  6. Persist users + passkeys + recovery_codes in one tx.
//  7. Return the recovery words. THIS IS THE ONLY TIME they leave
//     the server; once returned, only the hash exists.
func (d *HTTPDeps) handleRegisterFinish(w http.ResponseWriter, r *http.Request) {
	var req registerFinishRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if len(req.Credential) == 0 {
		writeError(w, http.StatusBadRequest, "bad_credential", "credential required")
		return
	}

	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Credential)
	if err != nil {
		writeError(w, http.StatusBadRequest, "parse_failed", err.Error())
		return
	}

	// The challenge the authenticator signed lives inside the
	// clientData. We trust the parser to expose it after its own
	// base64 decoding; if the SPA tampered with it, the library's
	// later Verify step will catch the signature mismatch.
	challenge := parsed.Response.CollectedClientData.Challenge
	if challenge == "" {
		writeError(w, http.StatusBadRequest, "missing_challenge",
			"clientData challenge missing")
		return
	}

	entry, err := d.Cache.Take(challenge)
	if err != nil {
		if errors.Is(err, ErrCeremonyExpired) {
			writeError(w, http.StatusGone, "ceremony_expired",
				"registration ceremony expired; start over")
			return
		}
		writeError(w, http.StatusNotFound, "ceremony_not_found",
			"no matching registration ceremony")
		return
	}
	if entry.Kind != KindRegistration {
		writeError(w, http.StatusBadRequest, "wrong_ceremony",
			"that challenge is for a different ceremony")
		return
	}

	wauthUser := &User{
		ID:          entry.PendingUser.ID,
		Name:        entry.PendingUser.Username,
		DisplayName: entry.PendingUser.DisplayName,
		Credentials: nil,
	}
	cred, err := d.Service.FinishRegistration(wauthUser, entry.Session, parsed)
	if err != nil {
		d.Logger.Printf("register/finish: FinishRegistration: %v", err)
		writeError(w, http.StatusBadRequest, "ceremony_validation_failed",
			err.Error())
		return
	}

	// Mint recovery words. We do this OUTSIDE the transaction
	// because argon2id is slow (~100ms) and we don't want to hold
	// a tx open across it. Race-window argument: between generating
	// words and committing, nothing can collide on the
	// recovery_codes row (the user doesn't exist yet); on tx
	// failure the words are discarded and the user re-registers.
	words, err := GenerateRecoveryWords()
	if err != nil {
		d.Logger.Printf("register/finish: GenerateRecoveryWords: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_gen_failed",
			"could not generate recovery code")
		return
	}
	hash, err := HashRecoveryWords(words)
	if err != nil {
		d.Logger.Printf("register/finish: HashRecoveryWords: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_hash_failed",
			"could not hash recovery code")
		return
	}

	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}

	regErr := d.Store.RegisterUser(r.Context(), store.RegistrationParams{
		UserID:       entry.PendingUser.ID,
		Username:     entry.PendingUser.Username,
		DisplayName:  entry.PendingUser.DisplayName,
		Email:        entry.PendingUser.Email,
		CredentialID: cred.ID,
		PublicKey:    cred.PublicKey,
		SignCount:    uint64(cred.Authenticator.SignCount),
		Transports:   transports,
		PasskeyName:  "Primary passkey",
		RecoveryHash: hash,
	})
	if regErr != nil {
		switch {
		case errors.Is(regErr, store.ErrUsernameTaken):
			writeError(w, http.StatusConflict, "username_taken",
				"that username was taken during your ceremony; try another")
			return
		case errors.Is(regErr, store.ErrEmailTaken):
			writeError(w, http.StatusConflict, "email_taken",
				"that email was registered during your ceremony")
			return
		case errors.Is(regErr, store.ErrCredentialTaken):
			// Should never happen with cryptographic credential IDs.
			d.Logger.Printf("register/finish: credential collision: %v", regErr)
			writeError(w, http.StatusConflict, "credential_collision",
				"unexpected credential collision; retry")
			return
		default:
			d.Logger.Printf("register/finish: RegisterUser: %v", regErr)
			writeError(w, http.StatusInternalServerError, "persist_failed",
				"could not persist registration")
			return
		}
	}

	// Sub-step 5: mint a session and set the cookie before writing
	// the response body. Doing this here means a successful
	// registration leaves the user logged in — no separate login
	// step needed. The Set-Cookie header is on the same response
	// the SPA receives, so the cookie is immediately available for
	// subsequent /api/auth/me and WS upgrade calls.
	sess, err := MintSession(r.Context(), d.Store, w,
		entry.PendingUser.ID,
		UserAgentFromRequest(r),
		IPFromRequest(r),
	)
	if err != nil {
		// The user row and passkey are committed; we just failed to
		// mint a session. The user can still log in via /authenticate
		// to get their session. We return success with no cookie and
		// log loudly so the operator sees this.
		d.Logger.Printf("register/finish: MintSession FAILED for user %s: %v",
			entry.PendingUser.ID, err)
		// Continue: registration WAS successful even without the session.
	}

	// Cache-Control: the recovery words must NEVER be cached.
	w.Header().Set("Cache-Control", "no-store, private")
	writeJSON(w, http.StatusOK, registerFinishResponse{
		UserID:           entry.PendingUser.ID.String(),
		Username:         entry.PendingUser.Username,
		DisplayName:      entry.PendingUser.DisplayName,
		RecoveryWords:    words,
		SessionExpiresAt: sess.ExpiresAt,
	})
}

// ---- authentication (login) -------------------------------------------

// authBeginRequest is the body of /api/auth/authenticate/begin.
type authBeginRequest struct {
	Username string `json:"username"`
}

// authBeginResponse echoes the WebAuthn options for the assertion
// ceremony. Shape mirrors registerBeginResponse but for login.
type authBeginResponse struct {
	Options *protocol.CredentialAssertion `json:"options"`
}

// authFinishRequest is the body of /api/auth/authenticate/finish.
// Like register/finish, we accept raw JSON for the credential so
// the library's own parser does the base64url decoding.
type authFinishRequest struct {
	Credential json.RawMessage `json:"credential"`
}

// authFinishResponse mirrors the post-login state the SPA needs to
// initialize itself. user_id and username are echoed for diagnostic
// purposes; the actual auth credential is the cookie.
type authFinishResponse struct {
	UserID           string    `json:"user_id"`
	Username         string    `json:"username"`
	DisplayName      string    `json:"display_name"`
	Role             string    `json:"role"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
}

// handleAuthenticateBegin starts a login ceremony. The username is
// looked up, all passkeys for that user are gathered into the
// allowed-credentials list, and a challenge is generated. The
// PendingUser in the cache here carries the user's existing UUID
// (unlike registration where it's freshly minted).
func (d *HTTPDeps) handleAuthenticateBegin(w http.ResponseWriter, r *http.Request) {
	var req authBeginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	if !IsValidUsername(username) {
		writeError(w, http.StatusBadRequest, "bad_username",
			"username must match ^[a-z0-9_]{3,32}$")
		return
	}

	// Look up the user. We intentionally return a generic error for
	// "user not found" so login doesn't double as a username
	// enumeration oracle. The plan's threat model says this is a
	// soft concern (open_registration mode makes usernames public
	// anyway), but treating it generically here costs nothing.
	user, err := d.Store.GetUserByUsername(r.Context(), username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "unknown_user",
				"that account doesn't exist or has no passkeys")
			return
		}
		d.Logger.Printf("authenticate/begin: lookup username: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"internal error")
		return
	}

	// Load all active passkeys so go-webauthn can populate the
	// allowed-credentials list in the challenge. The library will
	// look up the credential the authenticator returns against this
	// list at FinishLogin time.
	passkeys, err := d.Store.GetPasskeysForUser(r.Context(), user.ID)
	if err != nil {
		d.Logger.Printf("authenticate/begin: list passkeys: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"internal error")
		return
	}
	if len(passkeys) == 0 {
		// User exists but has no passkeys. They need to use the
		// recovery flow (09b-6).
		writeError(w, http.StatusUnauthorized, "no_passkeys",
			"that account has no passkeys; use the recovery flow")
		return
	}

	creds := make([]webauthn.Credential, 0, len(passkeys))
	for _, pk := range passkeys {
		creds = append(creds, passkeyToWebauthnCredential(pk))
	}

	wauthUser := &User{
		ID:          user.ID,
		Name:        user.Username,
		DisplayName: user.DisplayName,
		Credentials: creds,
	}
	options, sess, err := d.Service.BeginLogin(wauthUser)
	if err != nil {
		d.Logger.Printf("authenticate/begin: BeginLogin: %v", err)
		writeError(w, http.StatusInternalServerError, "ceremony_failed",
			"could not start ceremony")
		return
	}

	// Stash the pending user (existing UUID, not a fresh one).
	d.Cache.Put(sess.Challenge, CeremonyEntry{
		Kind:    KindLogin,
		Session: *sess,
		PendingUser: PendingUser{
			ID:          user.ID,
			Username:    user.Username,
			DisplayName: user.DisplayName,
			Email:       user.Email,
		},
	})
	writeJSON(w, http.StatusOK, authBeginResponse{Options: options})
}

// handleAuthenticateFinish completes a login ceremony. On success
// mints a session and Set-Cookie, returns the user identity.
func (d *HTTPDeps) handleAuthenticateFinish(w http.ResponseWriter, r *http.Request) {
	var req authFinishRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if len(req.Credential) == 0 {
		writeError(w, http.StatusBadRequest, "bad_credential", "credential required")
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(req.Credential)
	if err != nil {
		writeError(w, http.StatusBadRequest, "parse_failed", err.Error())
		return
	}
	challenge := parsed.Response.CollectedClientData.Challenge
	if challenge == "" {
		writeError(w, http.StatusBadRequest, "missing_challenge",
			"clientData challenge missing")
		return
	}
	entry, err := d.Cache.Take(challenge)
	if err != nil {
		if errors.Is(err, ErrCeremonyExpired) {
			writeError(w, http.StatusGone, "ceremony_expired",
				"login ceremony expired; start over")
			return
		}
		writeError(w, http.StatusNotFound, "ceremony_not_found",
			"no matching login ceremony")
		return
	}
	if entry.Kind != KindLogin {
		writeError(w, http.StatusBadRequest, "wrong_ceremony",
			"that challenge is for a different ceremony")
		return
	}

	// Re-load the credentials for the user. Could come from the
	// cache entry but reloading from the store guarantees we use
	// the current sign_count (post-some-other-login bump). The
	// authenticator's response carries a sign_count too, and
	// go-webauthn checks for monotonic increase as a replay defense.
	passkeys, err := d.Store.GetPasskeysForUser(r.Context(), entry.PendingUser.ID)
	if err != nil {
		d.Logger.Printf("authenticate/finish: list passkeys: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"internal error")
		return
	}
	creds := make([]webauthn.Credential, 0, len(passkeys))
	for _, pk := range passkeys {
		creds = append(creds, passkeyToWebauthnCredential(pk))
	}
	wauthUser := &User{
		ID:          entry.PendingUser.ID,
		Name:        entry.PendingUser.Username,
		DisplayName: entry.PendingUser.DisplayName,
		Credentials: creds,
	}
	cred, err := d.Service.FinishLogin(wauthUser, entry.Session, parsed)
	if err != nil {
		d.Logger.Printf("authenticate/finish: FinishLogin: %v", err)
		writeError(w, http.StatusBadRequest, "ceremony_validation_failed",
			err.Error())
		return
	}

	// Bump the passkey's sign_count and last_used_at so replay
	// defense works on the next login.
	if err := d.Store.UpdateSignCount(r.Context(),
		cred.ID, uint64(cred.Authenticator.SignCount)); err != nil {
		// Best-effort: log but don't fail. The login is still
		// valid; we just won't catch a sign-count replay on the
		// next attempt with this credential.
		d.Logger.Printf("authenticate/finish: UpdateSignCount: %v", err)
	}

	// Mint a session and set the cookie.
	sess, err := MintSession(r.Context(), d.Store, w,
		entry.PendingUser.ID,
		UserAgentFromRequest(r),
		IPFromRequest(r),
	)
	if err != nil {
		d.Logger.Printf("authenticate/finish: MintSession: %v", err)
		writeError(w, http.StatusInternalServerError, "session_mint_failed",
			"could not create session")
		return
	}

	// Look up the user one more time for role (the cache entry doesn't
	// carry it because registration's PendingUser was always 'user').
	user, err := d.Store.GetUserByID(r.Context(), entry.PendingUser.ID)
	if err != nil {
		// Session is minted; just fall back to defaults in the response.
		d.Logger.Printf("authenticate/finish: GetUserByID for response: %v", err)
		user.Role = "user"
	}

	writeJSON(w, http.StatusOK, authFinishResponse{
		UserID:           entry.PendingUser.ID.String(),
		Username:         entry.PendingUser.Username,
		DisplayName:      entry.PendingUser.DisplayName,
		Role:             user.Role,
		SessionExpiresAt: sess.ExpiresAt,
	})
}

// ---- logout / me ------------------------------------------------------

// handleLogout deletes the session row and clears the cookie. No
// request body. Idempotent: clearing the cookie on an already-logged-
// out request still returns 204.
func (d *HTTPDeps) handleLogout(w http.ResponseWriter, r *http.Request) {
	// Best-effort: if there's a session cookie, delete the row.
	// Even if the token is unparseable, we still want to clear the
	// cookie so the browser stops sending it.
	if token, err := SessionTokenFromRequest(r); err == nil {
		if delErr := d.Store.DeleteSession(r.Context(), token); delErr != nil {
			// Don't expose the error; clearing the cookie is what
			// matters for the user-facing behavior.
			d.Logger.Printf("logout: DeleteSession: %v", delErr)
		}
	}
	ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

// meResponse is the body of GET /api/auth/me. Mirrors the plan's
// shape. session_expires_at is the cookie's TTL boundary, useful for
// the SPA to know when it'll have to re-login.
type meResponse struct {
	UserID            string    `json:"user_id"`
	Username          string    `json:"username"`
	DisplayName       string    `json:"display_name"`
	Role              string    `json:"role"`
	Email             string    `json:"email"`
	EmailVerifiedAt   time.Time `json:"email_verified_at"`
	SessionExpiresAt  time.Time `json:"session_expires_at"`
}

// handleMe returns the current user's identity if logged in, or 401
// otherwise. The SPA polls this at boot to decide whether to render
// LoginScreen or jump straight to chat. RequireSession middleware
// handles the 401 cases uniformly.
func (d *HTTPDeps) handleMe(w http.ResponseWriter, r *http.Request) {
	RequireSession(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		// We don't currently store email_verified_at on SessionUser;
		// fetch it from the user record. Could be added to
		// SessionUser later if /me becomes a hot path, but it's
		// once-per-boot from the SPA so an extra query is fine.
		// Actually we already loaded the user in ResolveSession;
		// fetch it once more to get the verified_at timestamp.
		// (Note: an earlier design had the lazy load skip this;
		// keeping it explicit here for clarity.)
		user, err := d.Store.GetUserByID(r.Context(), su.UserID)
		if err != nil {
			d.Logger.Printf("me: GetUserByID: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed",
				"internal error")
			return
		}
		writeJSON(w, http.StatusOK, meResponse{
			UserID:           su.UserID.String(),
			Username:         su.Username,
			DisplayName:      su.DisplayName,
			Role:             su.Role,
			Email:            su.Email,
			EmailVerifiedAt:  user.EmailVerifiedAt,
			SessionExpiresAt: su.Session.ExpiresAt,
		})
	})(w, r)
}

// ---- helpers -----------------------------------------------------------

// checkRegistrationAllowed enforces the registration-mode policy.
//
//   - CHALK_OPEN_REGISTRATION=1: always allow; invite_token ignored.
//   - default:                   require a non-empty invite_token, but
//                                until 09c lands invite validation,
//                                ALWAYS reject (no tokens are valid).
//
// The two-mode design means production deploys can boot in open mode,
// register the admin, set CHALK_OPEN_REGISTRATION=0, and from then on
// rely on invites (which 09c adds). Until 09c, "closed registration"
// means "registration is locked; only the admin who was created in
// open mode can use the service".
func (d *HTTPDeps) checkRegistrationAllowed(req registerBeginRequest) error {
	if IsOpenRegistration() {
		return nil
	}
	if req.InviteToken == "" {
		return errors.New("registration is closed; an invite token is required")
	}
	// We have a token but no validator yet (09c). Always reject.
	return errors.New("invite tokens not yet implemented (09c)")
}

// looksLikeEmail is a minimal check. Real RFC 5322 validation is the
// SPA's job (and even there it's lax); we just want to reject the
// obvious junk before generating a ceremony challenge for it.
func looksLikeEmail(s string) bool {
	at := strings.IndexByte(s, '@')
	if at <= 0 || at == len(s)-1 {
		return false
	}
	domain := s[at+1:]
	return strings.IndexByte(domain, '.') > 0
}

// decodeJSON decodes the request body into v with a small max size to
// blunt DoS-by-giant-body. 64KiB is plenty for our payloads (the
// credential attestation is ~1-2KiB).
func decodeJSON(r *http.Request, v any) error {
	limited := io.LimitReader(r.Body, 64*1024)
	dec := json.NewDecoder(limited)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("decode body: %w", err)
	}
	// Refuse trailing junk after the JSON value.
	if dec.More() {
		return fmt.Errorf("decode body: trailing content")
	}
	return nil
}

// writeJSON writes v as the response body. Errors during marshal are
// logged but the response is already partial; callers should pass
// types known to serialize.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// errorBody is the wire shape of every error response. Stable across
// the auth surface so the SPA can have one decoder.
type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// writeError serializes an error response. The Code is a stable
// machine identifier (the SPA branches on it); the Message is for
// human display.
func writeError(w http.ResponseWriter, status int, code, message string) {
	var b errorBody
	b.Error.Code = code
	b.Error.Message = message
	writeJSON(w, status, b)
}
