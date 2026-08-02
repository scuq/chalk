package main

import (
	"flag"
	"testing"
)

// Go's flag package stops parsing at the first non-flag token. Every chalkctl
// command that takes a positional argument therefore has to parse around it,
// or the natural spelling -- `chalkctl restore backup.chalkbak --yes`,
// `chalkctl maint on --message "..."` -- silently drops the trailing flags:
// a restore that prompts when it was told not to, or a maintenance page
// carrying the wrong notice. Neither says anything went wrong.
func TestParsePositionalAcceptsFlagsOnEitherSide(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantPos []string
		wantMsg string
		wantYes bool
	}{
		{"flags after positional", []string{"on", "--message", "back at 14:00", "--yes"},
			[]string{"on"}, "back at 14:00", true},
		{"flags before positional", []string{"--message", "back at 14:00", "--yes", "on"},
			[]string{"on"}, "back at 14:00", true},
		{"flags on both sides", []string{"--yes", "on", "--message", "back at 14:00"},
			[]string{"on"}, "back at 14:00", true},
		{"equals form after positional", []string{"on", "--message=back at 14:00"},
			[]string{"on"}, "back at 14:00", false},
		{"no positional", []string{"--message", "x"}, nil, "x", false},
		{"positional only", []string{"off"}, []string{"off"}, "", false},
		{"two positionals", []string{"a", "--yes", "b"}, []string{"a", "b"}, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fs := flag.NewFlagSet("test", flag.ContinueOnError)
			msg := fs.String("message", "", "")
			yes := fs.Bool("yes", false, "")
			pos, err := parsePositional(fs, tc.args)
			if err != nil {
				t.Fatalf("parsePositional: %v", err)
			}
			if len(pos) != len(tc.wantPos) {
				t.Fatalf("positionals = %v, want %v", pos, tc.wantPos)
			}
			for i := range pos {
				if pos[i] != tc.wantPos[i] {
					t.Errorf("positional %d = %q, want %q", i, pos[i], tc.wantPos[i])
				}
			}
			if *msg != tc.wantMsg {
				t.Errorf("--message = %q, want %q", *msg, tc.wantMsg)
			}
			if *yes != tc.wantYes {
				t.Errorf("--yes = %v, want %v", *yes, tc.wantYes)
			}
		})
	}
}

func TestParsePositionalReportsBadFlags(t *testing.T) {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	fs.SetOutput(discard{})
	fs.String("message", "", "")
	if _, err := parsePositional(fs, []string{"on", "--nope"}); err == nil {
		t.Error("an unknown flag after the positional was accepted")
	}
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }
