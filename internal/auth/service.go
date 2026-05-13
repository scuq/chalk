package auth

import (
	"errors"
	"fmt"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// Config configures the auth service. All fields are required unless
// noted.
type Config struct {
	// RPID is the WebAuthn Relying Party ID. For browser ceremonies
	// this must be the effective domain of the chalk server (e.g.
	// "localhost" in dev, "chalk.example.com" in prod). Browsers
	// reject credentials whose RP ID doesn't match the page origin.
	//
	// Sourced from CHALK_RP_ID env var, defaulting to "localhost".
	RPID string

	// RPDisplayName is the human-readable RP name shown to the user
	// in the authenticator's UI ("Sign in to <RPDisplayName>?").
	//
	// Sourced from CHALK_RP_NAME env var, defaulting to "chalk".
	RPDisplayName string

	// RPOrigins is the list of origins allowed to initiate WebAuthn
	// ceremonies against this RP. Must include scheme and (if non-
	// default) port. For dev: ["http://localhost:8443"]. For prod:
	// ["https://chalk.example.com"]. Multiple origins are allowed
	// for multi-host deployments; we typically have one.
	//
	// Currently derived by the application from the listen address
	// and TLS mode; the auth.Config takes the final list to keep
	// the dependency direction one-way.
	RPOrigins []string
}

// Validate reports configuration errors that must be caught at
// startup rather than at first request.
func (c Config) Validate() error {
	if c.RPID == "" {
		return errors.New("auth: RPID required")
	}
	if c.RPDisplayName == "" {
		return errors.New("auth: RPDisplayName required")
	}
	if len(c.RPOrigins) == 0 {
		return errors.New("auth: at least one RPOrigin required")
	}
	for _, o := range c.RPOrigins {
		if o == "" {
			return errors.New("auth: RPOrigin entries must be non-empty")
		}
	}
	return nil
}

// Service is chalk's auth surface. Wraps go-webauthn for the ceremony
// primitives plus chalk-specific glue (reserved-username checks,
// recovery code generation, session minting in sub-step 4).
//
// Sub-step 2 ships construction only. The HTTP-layer wiring that
// turns these primitives into the actual /api/auth/* endpoints
// arrives in sub-step 3 (registration) and 4 (authentication).
//
// Service is safe for concurrent use; underneath, the go-webauthn
// *WebAuthn instance is read-only after construction.
type Service struct {
	cfg Config
	wa  *webauthn.WebAuthn
}

// NewService constructs an auth service from config. Validates the
// config and the underlying webauthn library setup; returns an error
// for any misconfiguration.
//
// The returned *Service is the only handle the rest of the program
// should hold. It does not own a database connection; storage is
// passed in per-call by sub-step 3 (the application keeps the Store
// reference in the server layer and threads it into the auth
// methods).
func NewService(cfg Config) (*Service, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          cfg.RPID,
		RPDisplayName: cfg.RPDisplayName,
		RPOrigins:     cfg.RPOrigins,
		// Phase 09b: UV (User Verification) preference = "preferred"
		// per plan DECISION 3. We accept biometric/PIN if the
		// authenticator supports it, but don't require it (security
		// keys without biometrics still work).
		//
		// AuthenticatorSelection is set per-ceremony in BeginRegistration
		// to allow registration-vs-add-passkey to make different
		// choices.
	})
	if err != nil {
		return nil, fmt.Errorf("auth: webauthn.New: %w", err)
	}
	return &Service{cfg: cfg, wa: wa}, nil
}

// RPID returns the configured RP ID. Diagnostics/tests only.
func (s *Service) RPID() string { return s.cfg.RPID }

// RPDisplayName returns the configured display name.
func (s *Service) RPDisplayName() string { return s.cfg.RPDisplayName }

// RPOrigins returns a copy of the configured origins.
func (s *Service) RPOrigins() []string {
	out := make([]string, len(s.cfg.RPOrigins))
	copy(out, s.cfg.RPOrigins)
	return out
}

// ---- Ceremony primitives ---------------------------------------------
//
// These thinly wrap the go-webauthn library calls but in chalk's
// vocabulary. Sub-step 3 wires them into HTTP handlers; sub-step 4
// wires the login pair.

// BeginRegistration starts a WebAuthn registration ceremony for the
// given user. Returns the credential-creation options the SPA must
// pass to navigator.credentials.create(), and a SessionData that must
// be persisted server-side until the ceremony's finish call.
//
// For a brand-new user (registration via invite), the caller
// constructs *User with a server-generated UUID and nil Credentials.
// For "add another passkey" on an existing user, the caller passes
// the existing user's UUID + loaded credentials so the library can
// build excludeCredentials (refusing to re-enroll an existing
// authenticator on the same account).
//
// The UV preference is "preferred"; the resident-key requirement is
// left at the library default (no specific requirement). These can
// be tuned via the options arg if a future caller needs to.
func (s *Service) BeginRegistration(user *User, opts ...webauthn.RegistrationOption) (*protocol.CredentialCreation, *webauthn.SessionData, error) {
	if user == nil {
		return nil, nil, errors.New("auth: BeginRegistration: user required")
	}
	// Default UV preference: preferred. Callers can override via opts.
	prefix := []webauthn.RegistrationOption{
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			UserVerification: protocol.VerificationPreferred,
		}),
	}
	merged := append(prefix, opts...)
	return s.wa.BeginRegistration(user, merged...)
}

// FinishRegistration completes a WebAuthn registration ceremony. The
// caller provides the SessionData from BeginRegistration and the
// parsed credential response from the SPA. Returns the credential
// to be persisted via store.AddPasskey.
//
// The library validates the attestation signature, RP ID match, and
// challenge nonce. A successful return means the credential is good
// to store; the caller still has to call store.AddPasskey AND, for
// the registration-via-invite path, create the users row in the
// same transaction.
//
// Note: the parsedResponse argument type comes from
// protocol.ParsedCredentialCreationData, which the application
// produces from the *http.Request body in the HTTP handler layer.
// We accept it pre-parsed so this method is decoupled from
// net/http (consistent with internal/auth's no-HTTP-routing scope
// in sub-step 2).
func (s *Service) FinishRegistration(user *User, sess webauthn.SessionData, parsedResponse *protocol.ParsedCredentialCreationData) (*webauthn.Credential, error) {
	if user == nil {
		return nil, errors.New("auth: FinishRegistration: user required")
	}
	if parsedResponse == nil {
		return nil, errors.New("auth: FinishRegistration: parsedResponse required")
	}
	return s.wa.CreateCredential(user, sess, parsedResponse)
}

// BeginLogin starts a WebAuthn authentication ceremony for an
// existing user. Returns the credential-request options for
// navigator.credentials.get(), and a SessionData to persist until
// FinishLogin. The caller MUST populate user.Credentials with the
// user's existing passkeys (loaded via store.GetPasskeysForUser);
// without them, the library can't construct the allowCredentials
// list and the ceremony will not succeed.
func (s *Service) BeginLogin(user *User, opts ...webauthn.LoginOption) (*protocol.CredentialAssertion, *webauthn.SessionData, error) {
	if user == nil {
		return nil, nil, errors.New("auth: BeginLogin: user required")
	}
	if len(user.Credentials) == 0 {
		return nil, nil, errors.New("auth: BeginLogin: user has no credentials")
	}
	return s.wa.BeginLogin(user, opts...)
}

// FinishLogin completes a WebAuthn authentication ceremony. The
// library validates the assertion signature and the sign-count
// progression (clone detection). The returned Credential includes
// the updated sign_count, which the caller must persist via
// store.UpdateSignCount.
//
// Like FinishRegistration, this accepts the parsed protocol struct
// rather than *http.Request to keep the auth package free of HTTP
// dependencies.
func (s *Service) FinishLogin(user *User, sess webauthn.SessionData, parsedResponse *protocol.ParsedCredentialAssertionData) (*webauthn.Credential, error) {
	if user == nil {
		return nil, errors.New("auth: FinishLogin: user required")
	}
	if len(user.Credentials) == 0 {
		return nil, errors.New("auth: FinishLogin: user has no credentials")
	}
	if parsedResponse == nil {
		return nil, errors.New("auth: FinishLogin: parsedResponse required")
	}
	return s.wa.ValidateLogin(user, sess, parsedResponse)
}
