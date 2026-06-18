package auth

import (
	"strings"
	"testing"
)

func TestIsValidUsernameAccepts(t *testing.T) {
	good := []string{
		"alice",
		"bob",
		"abc",                              // minimum length
		"a1b2c3",                           // digits
		"snake_case",                       // underscore
		"0123456789",                       // all digits
		"abcdefghij0123456789klmnopqrstuv", // 32 chars
	}
	for _, u := range good {
		if !IsValidUsername(u) {
			t.Errorf("expected %q to be valid", u)
		}
	}
}

func TestIsValidUsernameRejects(t *testing.T) {
	bad := []string{
		"",                                  // empty
		"ab",                                // too short
		"Alice",                             // uppercase
		"al-ice",                            // hyphen
		"al ice",                            // space
		"al.ice",                            // dot
		"alíce",                             // unicode
		"alice!",                            // punctuation
		"thr-other_x",                       // hyphen mixed with allowed chars
		"abcdefghij0123456789klmnopqrstuvw", // 33 chars
		strings.Repeat("a", 33),             // 33 chars all-letters
	}
	for _, u := range bad {
		if IsValidUsername(u) {
			t.Errorf("expected %q to be INVALID", u)
		}
	}
}

func TestReservedUsernames(t *testing.T) {
	for _, u := range ReservedUsernames() {
		if !IsReservedUsername(u) {
			t.Errorf("%q is on the list but IsReservedUsername returned false", u)
		}
	}
	// Case insensitive
	if !IsReservedUsername("ADMIN") {
		t.Error("IsReservedUsername should be case insensitive")
	}
	if !IsReservedUsername("Admin") {
		t.Error("IsReservedUsername should accept mixed case")
	}

	// Non-reserved
	for _, u := range []string{"alice", "bob", "scuq", "user123"} {
		if IsReservedUsername(u) {
			t.Errorf("%q should not be reserved", u)
		}
	}
}

func TestReservedListShape(t *testing.T) {
	got := ReservedUsernames()
	// Stable sorted output.
	for i := 1; i < len(got); i++ {
		if got[i-1] > got[i] {
			t.Errorf("ReservedUsernames not sorted: %q > %q at index %d", got[i-1], got[i], i)
		}
	}
	// Every entry must itself be a valid username shape — otherwise
	// the database constraint and the reserved list would reject
	// different things.
	for _, u := range got {
		if !IsValidUsername(u) {
			t.Errorf("reserved %q does not match username shape", u)
		}
	}
}
