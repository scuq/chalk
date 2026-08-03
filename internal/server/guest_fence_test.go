package server

// 80-9: the application-fence drift test. The frame table is not
// hand-written: it is parsed out of internal/proto's SOURCE, so every frame
// constant that will ever exist lands here automatically. The invariant:
// guestAllowedFrames contains EXACTLY the reviewed set below -- a new frame
// is guest-denied by default (the map misses it), and silently ADDING one to
// the allowlist without updating this test is a red build.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"testing"
)

// protoFrameConstants parses ../proto and returns every `Type*` string
// constant's VALUE (the wire name), e.g. "create_channel", "voice_join".
func protoFrameConstants(t *testing.T) map[string]string {
	t.Helper()
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, "../proto", nil, 0)
	if err != nil {
		t.Fatalf("parse internal/proto: %v", err)
	}
	out := map[string]string{} // wire name -> Go constant name
	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			for _, decl := range file.Decls {
				gd, ok := decl.(*ast.GenDecl)
				if !ok || gd.Tok != token.CONST {
					continue
				}
				for _, spec := range gd.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for i, name := range vs.Names {
						if !strings.HasPrefix(name.Name, "Type") || i >= len(vs.Values) {
							continue
						}
						lit, ok := vs.Values[i].(*ast.BasicLit)
						if !ok || lit.Kind != token.STRING {
							continue
						}
						val, err := strconv.Unquote(lit.Value)
						if err != nil {
							continue
						}
						out[val] = name.Name
					}
				}
			}
		}
	}
	if len(out) < 40 {
		t.Fatalf("frame-constant enumeration looks broken: found only %d", len(out))
	}
	return out
}

func TestGuestFrameAllowlist(t *testing.T) {
	frames := protoFrameConstants(t)

	// The reviewed allowlist: the guest's whole protocol surface. Changing
	// guestAllowedFrames means changing THIS set in the same commit, with
	// the same scrutiny the fence got in review.
	want := map[string]bool{
		"list_channels":     true,
		"fetch_history":     true,
		"send":              true,
		"mark_read":         true,
		"fetch_identity":    true,
		"fetch_channel_key": true,
		"voice_join":        true,
		"voice_leave":       true,
		"voice_roster":      true,
		"voice_state":       true,
		"voice_signal":      true,
	}

	// Every allowlist entry must be a real frame constant and in the
	// reviewed set.
	for ft := range guestAllowedFrames {
		if _, exists := frames[ft]; !exists {
			t.Errorf("allowlist entry %q is not a proto frame constant", ft)
		}
		if !want[ft] {
			t.Errorf("frame %q was added to the guest allowlist without updating the reviewed set in this test", ft)
		}
	}
	// And the reviewed set must be fully present (no silent narrowing that
	// the client then trips over at runtime).
	for ft := range want {
		if !guestAllowedFrames[ft] {
			t.Errorf("reviewed frame %q missing from the guest allowlist", ft)
		}
	}

	// Spot the invariant on the whole enumerated table: everything not in
	// the reviewed set is denied. (This is what makes a NEW frame safe by
	// default -- it appears here and lands in the denied branch.)
	denied := 0
	for wire := range frames {
		if !guestAllowedFrames[wire] {
			denied++
			if want[wire] {
				t.Errorf("frame %q should be allowed but is denied", wire)
			}
		}
	}
	if denied == 0 {
		t.Error("no denied frames at all; the fence is not fencing")
	}

	// The frames the fence exists for must never quietly join the list.
	for _, mustDeny := range []string{
		"create_channel", "add_member", "remove_member", "friend_request",
		"publish_identity", "publish_channel_key", "rotate_channel_key",
		"gov_set_mode", "delete_message", "edit_message", "set_reactions",
		"ephemeral_invite_mint", "ephemeral_invite_revoke",
	} {
		if _, exists := frames[mustDeny]; !exists {
			t.Errorf("expected frame constant %q to exist (test drifted from proto)", mustDeny)
			continue
		}
		if guestAllowedFrames[mustDeny] {
			t.Errorf("frame %q must NEVER be guest-allowed", mustDeny)
		}
	}
}
