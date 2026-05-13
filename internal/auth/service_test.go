package auth

import (
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
)

func TestConfigValidate(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		ok   bool
	}{
		{
			"valid",
			Config{RPID: "localhost", RPDisplayName: "chalk", RPOrigins: []string{"http://localhost:8443"}},
			true,
		},
		{"empty RPID", Config{RPDisplayName: "chalk", RPOrigins: []string{"x"}}, false},
		{"empty display name", Config{RPID: "localhost", RPOrigins: []string{"x"}}, false},
		{"no origins", Config{RPID: "localhost", RPDisplayName: "chalk"}, false},
		{
			"empty origin entry",
			Config{RPID: "localhost", RPDisplayName: "chalk", RPOrigins: []string{""}},
			false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.cfg.Validate()
			if tc.ok && err != nil {
				t.Errorf("expected ok, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Errorf("expected error, got nil")
			}
		})
	}
}

func TestNewService(t *testing.T) {
	cfg := Config{
		RPID:          "localhost",
		RPDisplayName: "chalk",
		RPOrigins:     []string{"http://localhost:8443"},
	}
	svc, err := NewService(cfg)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	if svc.RPID() != "localhost" {
		t.Errorf("RPID = %q", svc.RPID())
	}
	if svc.RPDisplayName() != "chalk" {
		t.Errorf("RPDisplayName = %q", svc.RPDisplayName())
	}
	got := svc.RPOrigins()
	if len(got) != 1 || got[0] != "http://localhost:8443" {
		t.Errorf("RPOrigins = %v", got)
	}
}

func TestNewServiceInvalidConfig(t *testing.T) {
	_, err := NewService(Config{})
	if err == nil {
		t.Error("expected error for empty config")
	}
}

func TestBeginRegistrationProducesChallenge(t *testing.T) {
	svc, err := NewService(Config{
		RPID:          "localhost",
		RPDisplayName: "chalk",
		RPOrigins:     []string{"http://localhost:8443"},
	})
	if err != nil {
		t.Fatal(err)
	}
	user := &User{
		ID:          uuid.New(),
		Name:        "alice",
		DisplayName: "Alice",
		Credentials: nil, // brand-new registration
	}
	cc, sess, err := svc.BeginRegistration(user)
	if err != nil {
		t.Fatalf("BeginRegistration: %v", err)
	}
	if cc == nil || sess == nil {
		t.Fatal("BeginRegistration returned nil cc or sess")
	}
	// Challenge bytes must be non-empty.
	if len(cc.Response.Challenge) == 0 {
		t.Error("challenge is empty")
	}
	// RP ID must match config.
	if cc.Response.RelyingParty.ID != "localhost" {
		t.Errorf("RelyingParty.ID = %q", cc.Response.RelyingParty.ID)
	}
	// User ID in the response must be present. We do not byte-compare
	// against user.WebAuthnID() here because go-webauthn v0.13+ types
	// the User.ID field as `any` (either []byte or string depending
	// on Config.EncodeUserIDAsString), so the comparison has to
	// type-switch. Presence is enough at the wrapper level; the
	// library's own tests cover the encoding round-trip.
	switch v := cc.Response.User.ID.(type) {
	case []byte:
		if len(v) == 0 {
			t.Error("response.User.ID ([]byte) is empty")
		}
	case string:
		if v == "" {
			t.Error("response.User.ID (string) is empty")
		}
	case nil:
		t.Error("response.User.ID is nil")
	default:
		// Unknown shape -- accept and let the integration tests in
		// sub-step 3 catch any wire-format issue.
	}
}

func TestBeginRegistrationNilUserRefused(t *testing.T) {
	svc, _ := NewService(Config{
		RPID:          "localhost",
		RPDisplayName: "chalk",
		RPOrigins:     []string{"http://localhost:8443"},
	})
	_, _, err := svc.BeginRegistration(nil)
	if err == nil {
		t.Error("expected error for nil user")
	}
	if !strings.Contains(err.Error(), "user required") {
		t.Errorf("error text: %v", err)
	}
}

func TestBeginLoginRequiresCredentials(t *testing.T) {
	svc, _ := NewService(Config{
		RPID:          "localhost",
		RPDisplayName: "chalk",
		RPOrigins:     []string{"http://localhost:8443"},
	})
	user := &User{
		ID:          uuid.New(),
		Name:        "alice",
		DisplayName: "Alice",
		Credentials: nil, // no credentials -> can't start login
	}
	_, _, err := svc.BeginLogin(user)
	if err == nil {
		t.Error("expected error for user with no credentials")
	}
	if !strings.Contains(err.Error(), "no credentials") {
		t.Errorf("error text: %v", err)
	}
}

func TestFinishRegistrationNilResponseRefused(t *testing.T) {
	svc, _ := NewService(Config{
		RPID:          "localhost",
		RPDisplayName: "chalk",
		RPOrigins:     []string{"http://localhost:8443"},
	})
	user := &User{ID: uuid.New(), Name: "alice", DisplayName: "Alice"}
	// We don't have a real SessionData to pass; the nil-response
	// check should fire first.
	_, err := svc.FinishRegistration(user, webauthn.SessionData{}, nil)
	if err == nil {
		t.Error("expected error for nil parsedResponse")
	}
}

func TestFinishLoginNilResponseRefused(t *testing.T) {
	svc, _ := NewService(Config{
		RPID:          "localhost",
		RPDisplayName: "chalk",
		RPOrigins:     []string{"http://localhost:8443"},
	})
	// Need at least one credential for the precheck to pass; just a
	// placeholder is fine because the nil-response check fires next.
	user := &User{
		ID:          uuid.New(),
		Name:        "alice",
		DisplayName: "Alice",
		Credentials: []webauthn.Credential{{ID: []byte("placeholder")}},
	}
	_, err := svc.FinishLogin(user, webauthn.SessionData{}, nil)
	if err == nil {
		t.Error("expected error for nil parsedResponse")
	}
}
