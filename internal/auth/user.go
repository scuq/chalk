package auth

import (
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
)

// User adapts a chalk user identity to the webauthn.User interface
// expected by github.com/go-webauthn/webauthn. The library uses this
// in BeginRegistration / BeginLogin / FinishRegistration / FinishLogin
// to compute the user handle on the wire and the allowCredentials /
// excludeCredentials lists.
//
// Two construction modes:
//
//   - Registration (no existing user row): the application has
//     collected username + display_name from a form, generated a UUID
//     server-side, and is about to call BeginRegistration. There are
//     no credentials yet; Credentials is nil. The library uses ID,
//     Name, and DisplayName to build the registration challenge.
//
//   - Login or add-passkey (existing user row + stored passkeys): the
//     application has loaded the user from store.GetUserBy* and the
//     user's passkeys from store.GetPasskeysForUser. Credentials must
//     reflect those passkeys so the library can compute the correct
//     allowCredentials list for the assertion ceremony.
//
// User is constructed by code that knows which mode it's in; this
// type does not enforce a particular shape. The auth service's
// registration and login flows construct it both ways.
type User struct {
	// ID is the immutable user UUID. For registration, the server
	// generates this before BeginRegistration; for login, it's the
	// existing users.id. The WebAuthn user handle is the UUID's
	// 16-byte binary encoding.
	ID uuid.UUID

	// Name is the chalk username (immutable, login key). Goes on the
	// wire in the credential's userHandle context.
	Name string

	// DisplayName is the mutable, free-form display_name. Shown to
	// the user in the authenticator's UI ("Sign in to chalk as Bob").
	DisplayName string

	// Credentials is the user's currently-registered passkeys. Nil
	// for the registration path (no credentials exist yet); non-nil
	// for login and add-passkey paths.
	Credentials []webauthn.Credential
}

// WebAuthnID returns the user handle as raw bytes. WebAuthn requires
// it to be a stable, opaque identifier (NOT username or email; those
// can change). We use the UUID's 16-byte representation.
//
// Note: the WebAuthn spec recommends the user handle be a 64-byte
// random opaque value, but the spec ALLOWS smaller values; a UUID is
// the standard chalk identifier already, so we use it. If we ever
// want to support user handle rotation, this can become a separate
// field on users without breaking existing credentials.
func (u *User) WebAuthnID() []byte {
	b, _ := u.ID.MarshalBinary()
	return b
}

// WebAuthnName returns the username. Used by the library as the
// credential's "name" field.
func (u *User) WebAuthnName() string { return u.Name }

// WebAuthnDisplayName returns the user's display name. Used by the
// library as the credential's "displayName" field.
func (u *User) WebAuthnDisplayName() string { return u.DisplayName }

// WebAuthnCredentials returns the user's existing credentials. Empty
// slice (not nil — the library prefers a non-nil slice for the JSON
// shape) during a fresh registration.
func (u *User) WebAuthnCredentials() []webauthn.Credential {
	if u.Credentials == nil {
		return []webauthn.Credential{}
	}
	return u.Credentials
}
