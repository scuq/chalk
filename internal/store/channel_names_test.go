package store

// 106-3: the short-name normalizer is the one rule the handler, the
// create path and the update path all share, so it is pinned here
// without a database. The 0054 CHECK counts characters; so must this.

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizeShortName(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", ""},
		{"   ", ""},
		{"  gen  ", "gen"},
		{"0123456789", "0123456789"}, // exactly ten
		{"ünïcödé-ok", "ünïcödé-ok"}, // ten characters, more bytes
		{"🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮", "🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮"}, // ten emoji, forty bytes
	}
	for _, c := range cases {
		got, err := NormalizeShortName(c.in)
		if err != nil {
			t.Errorf("%q: unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("%q: got %q want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeShortNameTooLong(t *testing.T) {
	for _, in := range []string{
		"01234567890",             // eleven
		strings.Repeat("🎮", 11),   // eleven characters
		"  01234567890  ",         // trimmed, still eleven
		strings.Repeat("a", 1000), // absurd
	} {
		if _, err := NormalizeShortName(in); !errors.Is(err, ErrShortNameTooLong) {
			t.Errorf("%q: want ErrShortNameTooLong, got %v", in, err)
		}
	}
}
