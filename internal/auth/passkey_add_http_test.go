package auth

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

func TestPasskeyToDTO(t *testing.T) {
	created := time.Unix(1_700_000_000, 0).UTC()
	used := created.Add(time.Hour)
	pk := store.Passkey{
		CredentialID: []byte{0x01, 0x02, 0x03, 0xff},
		UserID:       uuid.New(),
		Name:         "Work laptop",
		Transports:   []string{"internal", "hybrid"},
		CreatedAt:    created,
		LastUsedAt:   used,
	}
	dto := passkeyToDTO(pk)

	if want := base64.RawURLEncoding.EncodeToString(pk.CredentialID); dto.ID != want {
		t.Errorf("ID = %q, want %q", dto.ID, want)
	}
	if dto.Name != "Work laptop" {
		t.Errorf("Name = %q", dto.Name)
	}
	if dto.CreatedAt != created.UnixMilli() {
		t.Errorf("CreatedAt = %d, want %d", dto.CreatedAt, created.UnixMilli())
	}
	if dto.LastUsedAt != used.UnixMilli() {
		t.Errorf("LastUsedAt = %d, want %d", dto.LastUsedAt, used.UnixMilli())
	}
	if len(dto.Transports) != 2 {
		t.Errorf("Transports = %v", dto.Transports)
	}
}

func TestPasskeyToDTONeverUsedOmitsLastUsed(t *testing.T) {
	pk := store.Passkey{
		CredentialID: []byte{0xaa},
		CreatedAt:    time.Unix(1_700_000_000, 0).UTC(),
		// LastUsedAt zero -> never used
	}
	dto := passkeyToDTO(pk)
	if dto.LastUsedAt != 0 {
		t.Errorf("LastUsedAt = %d, want 0 (never used)", dto.LastUsedAt)
	}
}

func TestPasskeyToDTONilTransportsBecomesEmptySlice(t *testing.T) {
	pk := store.Passkey{
		CredentialID: []byte{0xbb},
		CreatedAt:    time.Unix(1_700_000_000, 0).UTC(),
		Transports:   nil,
	}
	dto := passkeyToDTO(pk)
	if dto.Transports == nil {
		t.Fatal("Transports should be an empty slice, not nil (marshals to [] not null)")
	}
	if len(dto.Transports) != 0 {
		t.Errorf("Transports = %v, want empty", dto.Transports)
	}
}

func TestSanitizePasskeyName(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"  Work laptop  ", "Work laptop"},
		{"", ""},
		{"   ", ""},
		{strings.Repeat("x", maxPasskeyNameLen+10), strings.Repeat("x", maxPasskeyNameLen)},
	}
	for _, c := range cases {
		if got := sanitizePasskeyName(c.in); got != c.want {
			t.Errorf("sanitizePasskeyName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
