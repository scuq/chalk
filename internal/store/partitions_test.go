package store

import (
	"testing"
	"time"
)

func TestQuoteIdent(t *testing.T) {
	cases := []struct{ in, want string }{
		{"messages_2026_05", `"messages_2026_05"`},
		{"weird name", `"weird name"`},
		{`with"quote`, `"with""quote"`},
	}
	for _, c := range cases {
		if got := quoteIdent(c.in); got != c.want {
			t.Errorf("quoteIdent(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestQuoteTimestamp(t *testing.T) {
	// A non-UTC input should still emit UTC.
	loc, _ := time.LoadLocation("America/New_York")
	in := time.Date(2026, 5, 1, 12, 0, 0, 0, loc) // 16:00 UTC
	got := quoteTimestamp(in)
	want := "'2026-05-01 16:00:00Z'"
	if got != want {
		t.Errorf("quoteTimestamp = %q, want %q", got, want)
	}
}
