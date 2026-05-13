package auth

import (
	"testing"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
)

func TestUserWebAuthnID(t *testing.T) {
	id := uuid.MustParse("00000000-0000-0000-0000-00000000a11c")
	u := &User{ID: id}
	got := u.WebAuthnID()
	if len(got) != 16 {
		t.Errorf("WebAuthnID len = %d, want 16", len(got))
	}
	// Last byte of 00000000-0000-0000-0000-00000000a11c is 0x1c.
	if got[15] != 0x1c {
		t.Errorf("WebAuthnID[15] = 0x%02x, want 0x1c", got[15])
	}
}

func TestUserWebAuthnName(t *testing.T) {
	u := &User{Name: "alice", DisplayName: "Alice"}
	if u.WebAuthnName() != "alice" {
		t.Errorf("WebAuthnName = %q", u.WebAuthnName())
	}
	if u.WebAuthnDisplayName() != "Alice" {
		t.Errorf("WebAuthnDisplayName = %q", u.WebAuthnDisplayName())
	}
}

func TestUserWebAuthnCredentialsEmpty(t *testing.T) {
	u := &User{}
	got := u.WebAuthnCredentials()
	if got == nil {
		t.Fatal("WebAuthnCredentials should never return nil")
	}
	if len(got) != 0 {
		t.Errorf("WebAuthnCredentials len = %d, want 0", len(got))
	}
}

func TestUserWebAuthnCredentialsRoundTrip(t *testing.T) {
	creds := []webauthn.Credential{
		{ID: []byte("cred1"), PublicKey: []byte("pk1")},
		{ID: []byte("cred2"), PublicKey: []byte("pk2")},
	}
	u := &User{Credentials: creds}
	got := u.WebAuthnCredentials()
	if len(got) != 2 {
		t.Fatalf("len = %d", len(got))
	}
	if string(got[0].ID) != "cred1" || string(got[1].ID) != "cred2" {
		t.Error("credential IDs not preserved")
	}
}
