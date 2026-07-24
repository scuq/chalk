// chalk -- phase31-slice31-6a signup v2 (password + TOTP first).
//
// The auth-v2 registration front door. Unlike the passkey-first flow
// (register/begin + register/finish), signup v2 creates an account from a
// password and a LIVE-VERIFIED TOTP enrollment; passkeys become an optional
// later addition (md-4's add-passkey endpoints, session-gated).
//
//	POST /api/auth/register/v2/begin
//	  {username, display_name, email, invite_token?}
//	  Runs the same admission checks as the passkey flow (open-reg/invite,
//	  username shape + reserved + taken, email shape + blacklist + taken),
//	  then parks a pending signup in memory and issues a fresh TOTP secret
//	  for it. -> {signup_token, provisioning_uri, secret_b32, expires_at}
//	  Nothing is written to the database at begin time.
//
//	POST /api/auth/register/v2/finish
//	  {signup_token, totp_code, auth_proof_b64, salt_b64, kdf_alg,
//	   kdf_mem_kib, kdf_iters, kdf_par}
//	  Verifies the live TOTP code against the pending secret (proof the
//	  authenticator actually works), enforces the Argon2id floor, then
//	  commits users + user_auth (TOTP confirmed, auth_v2_enrolled=true) +
//	  recovery_codes in ONE transaction, marks the invite used, mints a
//	  session, and returns the recovery words (shown once).
//
//	PUT  /api/auth/seed-wrap   (session) {generation, wrap_suite, wrap_b64}
//	GET  /api/auth/seed-wraps  (session) ?generation=N
//	  Upload / fetch the password-wrapped encryption-phrase entropy
//	  (identity_seed_wrap). The client calls PUT after the encryption-
//	  phrase step of the wizard, once it holds both the entropy and the
//	  password-derived KEK. GET serves new-device unlock (31-7).
//
// A failed finish (wrong TOTP code) does NOT consume the pending signup:
// the user re-reads their authenticator and retries. Codes are 6 digits and
// the signup token is unguessable, so there is no oracle to grind.
package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/scuq/chalk/internal/store"
)

// signupV2TTL bounds how long a begin-issued signup may take to finish.
// Scanning a QR and typing one code fits comfortably; 15 minutes is generous
// for a user who also reads the instructions.
const signupV2TTL = 15 * time.Minute

// pendingSignup is one in-flight v2 signup. The TOTP secret is held in
// PLAINTEXT here -- in process memory only, never persisted; the DB write at
// finish time stores the encrypted form.
type pendingSignup struct {
	User       PendingUser
	TOTPSecret []byte
	ExpiresAt  time.Time
}

// SignupV2Cache is a goroutine-safe TTL cache of pending v2 signups, keyed by
// an opaque random signup token. Modelled on PendingTOTPCache: no janitor
// goroutine; expired entries are swept opportunistically on Put.
type SignupV2Cache struct {
	mu      sync.Mutex
	entries map[string]pendingSignup
	now     func() time.Time
}

// NewSignupV2Cache returns an empty cache.
func NewSignupV2Cache() *SignupV2Cache {
	return &SignupV2Cache{entries: make(map[string]pendingSignup), now: time.Now}
}

// Put stores a pending signup under a fresh random token and returns it.
func (c *SignupV2Cache) Put(p pendingSignup) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, v := range c.entries {
		if now.After(v.ExpiresAt) {
			delete(c.entries, k)
		}
	}
	p.ExpiresAt = now.Add(signupV2TTL)
	c.entries[token] = p
	return token, nil
}

// Peek returns the entry without consuming it (finish retries on a wrong
// TOTP code). Expired entries are removed on lookup.
func (c *SignupV2Cache) Peek(token string) (pendingSignup, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[token]
	if !ok {
		return pendingSignup{}, ErrPendingNotFound
	}
	if c.now().After(e.ExpiresAt) {
		delete(c.entries, token)
		return pendingSignup{}, ErrPendingExpired
	}
	return e, nil
}

// Take consumes the entry (successful finish).
func (c *SignupV2Cache) Take(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, token)
}

// ---- handlers -------------------------------------------------------------

type signupV2BeginRequest struct {
	InviteToken string `json:"invite_token,omitempty"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	Email       string `json:"email,omitempty"`
}

type signupV2BeginResponse struct {
	SignupToken     string    `json:"signup_token"`
	ProvisioningURI string    `json:"provisioning_uri"`
	SecretB32       string    `json:"secret_b32"`
	ExpiresAt       time.Time `json:"expires_at"`
}

func (d *HTTPDeps) handleSignupV2Begin(w http.ResponseWriter, r *http.Request) {
	var req signupV2BeginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}

	// Admission: open-registration or a valid invite (same gate as the
	// passkey flow; checkRegistrationAllowed takes the begin-request shape).
	invite, authErr := d.checkRegistrationAllowed(r.Context(), registerBeginRequest{
		InviteToken: req.InviteToken,
		Username:    req.Username,
		DisplayName: req.DisplayName,
	})
	if authErr != nil {
		writeAuthErr(w, authErr)
		return
	}

	username := strings.ToLower(strings.TrimSpace(req.Username))
	email := strings.ToLower(strings.TrimSpace(req.Email))
	displayName := strings.TrimSpace(req.DisplayName)

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
	if email == "" && IsDevMode() {
		email = username + "@localhost.invalid"
	}
	if !looksLikeEmail(email) {
		writeError(w, http.StatusBadRequest, "bad_email",
			"email must contain @ and a domain")
		return
	}
	if invite != nil && !strings.EqualFold(invite.Email, email) {
		writeError(w, http.StatusConflict, "invite_email_mismatch",
			"this invite was issued for a different email address")
		return
	}
	blocked, err := d.Store.IsEmailBlacklisted(r.Context(), email)
	if err != nil {
		d.Logger.Printf("signup/v2/begin: blacklist check: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	if blocked {
		writeError(w, http.StatusForbidden, "email_blacklisted",
			"this email address cannot be used")
		return
	}
	if _, err := d.Store.GetUserByUsername(r.Context(), username); err == nil {
		writeError(w, http.StatusConflict, "username_taken", "that username is taken")
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		d.Logger.Printf("signup/v2/begin: username lookup: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	if _, err := d.Store.GetUserByEmail(r.Context(), email); err == nil {
		writeError(w, http.StatusConflict, "email_taken", "that email is already registered")
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		d.Logger.Printf("signup/v2/begin: email lookup: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}

	// TOTP-secret storage requires the enc key; fail loudly at begin rather
	// than after the user has scanned a QR that can never be committed.
	if _, err := EncryptTOTPSecret([]byte{0}); err != nil {
		if errors.Is(err, ErrTOTPEncKeyUnset) {
			d.Logger.Printf("signup/v2/begin: %v", err)
			writeError(w, http.StatusInternalServerError, "totp_enc_key_unset",
				"server is missing CHALK_TOTP_ENC_KEY; signups cannot proceed")
			return
		}
	}

	secret, err := GenerateTOTPSecret()
	if err != nil {
		d.Logger.Printf("signup/v2/begin: generate totp: %v", err)
		writeError(w, http.StatusInternalServerError, "totp_gen_failed", "internal error")
		return
	}

	if d.SignupV2 == nil {
		d.SignupV2 = NewSignupV2Cache()
	}
	pend := pendingSignup{
		User: PendingUser{
			ID:          uuid.New(),
			Username:    username,
			DisplayName: displayName,
			Email:       email,
		},
		TOTPSecret: secret,
	}
	if invite != nil {
		pend.User.InviteToken = invite.Token
	}
	token, err := d.SignupV2.Put(pend)
	if err != nil {
		d.Logger.Printf("signup/v2/begin: cache put: %v", err)
		writeError(w, http.StatusInternalServerError, "signup_cache_failed", "internal error")
		return
	}

	w.Header().Set("Cache-Control", "no-store, private")
	writeJSON(w, http.StatusOK, signupV2BeginResponse{
		SignupToken:     token,
		ProvisioningURI: ProvisioningURI(username, secret),
		SecretB32:       TOTPSecretBase32(secret),
		ExpiresAt:       time.Now().Add(signupV2TTL),
	})
}

type signupV2FinishRequest struct {
	SignupToken string `json:"signup_token"`
	TOTPCode    string `json:"totp_code"`
	newPasswordFields
}

type signupV2FinishResponse struct {
	UserID           string    `json:"user_id"`
	Username         string    `json:"username"`
	DisplayName      string    `json:"display_name"`
	RecoveryWords    []string  `json:"recovery_words"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
}

func (d *HTTPDeps) handleSignupV2Finish(w http.ResponseWriter, r *http.Request) {
	var req signupV2FinishRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if d.SignupV2 == nil {
		d.SignupV2 = NewSignupV2Cache()
	}
	pend, err := d.SignupV2.Peek(strings.TrimSpace(req.SignupToken))
	if err != nil {
		writeError(w, http.StatusGone, "signup_expired",
			"this signup expired; start again")
		return
	}

	// Live TOTP verification against the pending secret: the enrollment is
	// only accepted when the authenticator demonstrably produces valid codes.
	if _, ok := ValidateTOTP(pend.TOTPSecret, strings.TrimSpace(req.TOTPCode),
		time.Now(), TOTPSkew()); !ok {
		writeError(w, http.StatusUnauthorized, "invalid_totp",
			"incorrect authentication code; check your authenticator app")
		return
	}

	proofHash, salt, ok := decodeNewPassword(w, req.newPasswordFields)
	if !ok {
		return
	}

	secretEnc, err := EncryptTOTPSecret(pend.TOTPSecret)
	if err != nil {
		d.Logger.Printf("signup/v2/finish: encrypt totp: %v", err)
		writeError(w, http.StatusInternalServerError, "totp_enc_failed", "internal error")
		return
	}

	words, err := GenerateRecoveryWords()
	if err != nil {
		d.Logger.Printf("signup/v2/finish: GenerateRecoveryWords: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_gen_failed",
			"could not generate recovery code")
		return
	}
	recoveryHash, err := HashRecoveryWords(words)
	if err != nil {
		d.Logger.Printf("signup/v2/finish: HashRecoveryWords: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_hash_failed",
			"could not hash recovery code")
		return
	}

	regErr := d.Store.RegisterUserV2(r.Context(), store.RegistrationV2Params{
		UserID:        pend.User.ID,
		Username:      pend.User.Username,
		DisplayName:   pend.User.DisplayName,
		Email:         pend.User.Email,
		RecoveryHash:  recoveryHash,
		AuthProofHash: proofHash,
		AuthSalt:      salt,
		KDFAlg:        req.KDFAlg,
		KDFMemKiB:     req.KDFMemKiB,
		KDFIters:      req.KDFIters,
		KDFPar:        req.KDFPar,
		TOTPSecretEnc: secretEnc,
	})
	if regErr != nil {
		switch {
		case errors.Is(regErr, store.ErrUsernameTaken):
			writeError(w, http.StatusConflict, "username_taken",
				"that username was taken while you were signing up; start again")
		case errors.Is(regErr, store.ErrEmailTaken):
			writeError(w, http.StatusConflict, "email_taken",
				"that email was registered while you were signing up")
		default:
			d.Logger.Printf("signup/v2/finish: RegisterUserV2: %v", regErr)
			writeError(w, http.StatusInternalServerError, "persist_failed",
				"could not persist registration")
		}
		return
	}
	d.SignupV2.Take(strings.TrimSpace(req.SignupToken))

	if len(pend.User.InviteToken) > 0 {
		if markErr := d.Store.MarkInviteUsed(r.Context(),
			pend.User.InviteToken, pend.User.ID); markErr != nil {
			d.Logger.Printf("signup/v2/finish: MarkInviteUsed for %s: %v",
				pend.User.ID, markErr)
		}
	}

	sess, err := MintSession(r.Context(), d.Store, w,
		pend.User.ID, UserAgentFromRequest(r), IPFromRequest(r))
	if err != nil {
		d.Logger.Printf("signup/v2/finish: MintSession FAILED for %s: %v",
			pend.User.ID, err)
		// Registration IS committed; the user can log in normally.
	}

	w.Header().Set("Cache-Control", "no-store, private")
	writeJSON(w, http.StatusOK, signupV2FinishResponse{
		UserID:           pend.User.ID.String(),
		Username:         pend.User.Username,
		DisplayName:      pend.User.DisplayName,
		RecoveryWords:    words,
		SessionExpiresAt: sess.ExpiresAt,
	})
}

// ---- seed-wrap upload / fetch --------------------------------------------

type seedWrapPutRequest struct {
	Generation int    `json:"generation"`
	WrapSuite  int16  `json:"wrap_suite"`
	WrapB64    string `json:"wrap_b64"`
}

type seedWrapEntry struct {
	Method     string `json:"method"`
	Generation int    `json:"generation"`
	WrapSuite  int16  `json:"wrap_suite"`
	WrapB64    string `json:"wrap_b64"`
}

type seedWrapListResponse struct {
	Wraps []seedWrapEntry `json:"wraps"`
}

func (d *HTTPDeps) handleSeedWrapPut(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	var req seedWrapPutRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	blob, err := base64.StdEncoding.DecodeString(req.WrapB64)
	if err != nil || len(blob) == 0 {
		writeError(w, http.StatusBadRequest, "bad_wrap",
			"wrap_b64 must be non-empty base64")
		return
	}
	if req.WrapSuite < 1 {
		writeError(w, http.StatusBadRequest, "bad_wrap", "wrap_suite must be >= 1")
		return
	}
	if err := d.Store.PutIdentitySeedWrap(r.Context(), store.IdentitySeedWrap{
		UserID:     su.UserID,
		Method:     "password",
		Generation: req.Generation,
		WrapSuite:  req.WrapSuite,
		WrapBlob:   blob,
	}); err != nil {
		d.Logger.Printf("seed-wrap/put: %v", err)
		writeError(w, http.StatusInternalServerError, "wrap_store_failed", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"stored": true})
}

func (d *HTTPDeps) handleSeedWrapList(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	generation := 1
	if g := r.URL.Query().Get("generation"); g != "" {
		if n, err := strconv.Atoi(g); err == nil && n >= 1 {
			generation = n
		}
	}
	wraps, err := d.Store.ListIdentitySeedWraps(r.Context(), su.UserID, generation)
	if err != nil {
		d.Logger.Printf("seed-wrap/list: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	out := make([]seedWrapEntry, 0, len(wraps))
	for _, wr := range wraps {
		out = append(out, seedWrapEntry{
			Method:     wr.Method,
			Generation: wr.Generation,
			WrapSuite:  wr.WrapSuite,
			WrapB64:    base64.StdEncoding.EncodeToString(wr.WrapBlob),
		})
	}
	writeJSON(w, http.StatusOK, seedWrapListResponse{Wraps: out})
}
