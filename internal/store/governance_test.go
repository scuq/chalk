package store

import "testing"

// gov-1a: unit tests for the pure tally evaluator (EvaluateTally). DB-free, so
// these run in `go test ./internal/store/...` without a database. They pin the
// resolve-on-certainty math (spec H10): turnout quorum of the FROZEN snapshot
// plus a strict (super)majority of voters, resolving early only when the
// outcome is LOCKED against the un-cast remainder.

func TestEvaluateTally(t *testing.T) {
	cases := []struct {
		name      string
		E, Y, N   int
		quorum    int
		threshold int
		expired   bool
		want      TallyDecision
		locked    bool
	}{
		// Below quorum, nothing locked yet -> stay open.
		{"below quorum open", 5, 0, 0, 50, 50, false, DecisionOpen, false},
		// Turnout met and yes survives the whole remainder voting no -> pass, locked.
		{"pass locked", 5, 3, 0, 50, 50, false, DecisionPass, true},
		// Yes can't reach the bar even at full turnout -> fail, locked.
		{"fail locked all-no", 5, 0, 3, 50, 50, false, DecisionFail, true},
		// Transient majority (2 of 4) the remainder could overturn -> stay open.
		{"transient open", 4, 2, 0, 50, 50, false, DecisionOpen, false},
		// Same counts at expiry: 2 yes 0 no among 2 voters, turnout met -> pass.
		{"expiry pass", 4, 2, 0, 50, 50, true, DecisionPass, false},
		{"expiry pass 2y1n", 5, 2, 1, 50, 50, true, DecisionPass, false},
		// Pre-expiry the same 2y1n is not yet locked -> open.
		{"open before expiry 2y1n", 5, 2, 1, 50, 50, false, DecisionOpen, false},
		// Supermajority (67): 2 of 3 with 1 silent is not locked pre-expiry.
		{"super open 2y0n", 3, 2, 0, 50, 67, false, DecisionOpen, false},
		// At expiry both voters said yes (100% of voters) over 2/3 turnout -> pass.
		{"super expiry pass 2y0n", 3, 2, 0, 50, 67, true, DecisionPass, false},
		// Supermajority with a no on the board: can't reach 2/3 -> fail, locked.
		{"super fail locked 2y1n", 3, 2, 1, 50, 67, false, DecisionFail, true},
		// Degenerate empty snapshot: open until expiry, then fail.
		{"degenerate E0 open", 0, 0, 0, 50, 50, false, DecisionOpen, false},
		{"degenerate E0 expired", 0, 0, 0, 50, 50, true, DecisionFail, false},
		// Small channel, unanimous: locked pass (floor is enforced at creation,
		// not here, so the evaluator must still handle small E gracefully).
		{"small pass locked", 2, 2, 0, 50, 50, false, DecisionPass, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EvaluateTally(TallyInput{
				Eligible:         tc.E,
				Yes:              tc.Y,
				No:               tc.N,
				QuorumPercent:    tc.quorum,
				ThresholdPercent: tc.threshold,
				Expired:          tc.expired,
			})
			if got.Decision != tc.want {
				t.Errorf("decision = %q, want %q (E=%d Y=%d N=%d q=%d t=%d expired=%v)",
					got.Decision, tc.want, tc.E, tc.Y, tc.N, tc.quorum, tc.threshold, tc.expired)
			}
			if got.Locked != tc.locked {
				t.Errorf("locked = %v, want %v", got.Locked, tc.locked)
			}
			if got.Voted != tc.Y+tc.N {
				t.Errorf("voted = %d, want %d", got.Voted, tc.Y+tc.N)
			}
		})
	}
}

// A locked decision must never be reported at the same time as DecisionOpen,
// and an open decision must never be locked. Cross-check the invariant across a
// sweep of small boards.
func TestEvaluateTallyLockInvariant(t *testing.T) {
	for E := 0; E <= 7; E++ {
		for Y := 0; Y <= E; Y++ {
			for N := 0; N <= E-Y; N++ {
				for _, expired := range []bool{false, true} {
					r := EvaluateTally(TallyInput{
						Eligible: E, Yes: Y, No: N,
						QuorumPercent: 50, ThresholdPercent: 50, Expired: expired,
					})
					if r.Decision == DecisionOpen && r.Locked {
						t.Fatalf("open but locked: E=%d Y=%d N=%d expired=%v", E, Y, N, expired)
					}
					if expired && r.Decision == DecisionOpen {
						t.Fatalf("still open at expiry: E=%d Y=%d N=%d", E, Y, N)
					}
					if r.Locked && expired {
						// locked is a pre-expiry concept; at expiry we report the
						// terminal decision without the locked flag.
						if r.Decision != DecisionPass && r.Decision != DecisionFail {
							t.Fatalf("locked+expired but non-terminal: E=%d Y=%d N=%d", E, Y, N)
						}
					}
				}
			}
		}
	}
}

func TestGovernanceConfigWithDefaults(t *testing.T) {
	got := GovernanceConfig{}.withDefaults()
	want := GovernanceConfig{
		Mode: GovernanceModeDictator, VoteWindowDays: 30, VoteExpiryHours: 168,
		MinEligible: 3, QuorumPercent: 50, PassPercent: 50,
		SupermajorityPercent: 67, ReproposeCooldownHours: 168,
	}
	if got != want {
		t.Errorf("withDefaults() = %+v, want %+v", got, want)
	}
	// Out-of-range values are corrected.
	bad := GovernanceConfig{Mode: "", QuorumPercent: 0, PassPercent: 250}.withDefaults()
	if bad.QuorumPercent != 50 || bad.PassPercent != 50 || bad.Mode != GovernanceModeDictator {
		t.Errorf("withDefaults did not correct out-of-range: %+v", bad)
	}
}

func TestThresholdForSetModeDictator(t *testing.T) {
	base := Proposal{PassPercent: 50, SupermajorityPercent: 67}

	toDictator := base
	toDictator.Type = ProposalTypeSetMode
	toDictator.Payload = []byte(`{"mode":"dictator"}`)
	if got := thresholdFor(toDictator); got != 67 {
		t.Errorf("set_mode->dictator threshold = %d, want 67", got)
	}

	toDemocratic := base
	toDemocratic.Type = ProposalTypeSetMode
	toDemocratic.Payload = []byte(`{"mode":"democratic"}`)
	if got := thresholdFor(toDemocratic); got != 50 {
		t.Errorf("set_mode->democratic threshold = %d, want 50 (no supermajority)", got)
	}

	remove := base
	remove.Type = ProposalTypeRemoveMember
	if got := thresholdFor(remove); got != 50 {
		t.Errorf("remove_member threshold = %d, want 50", got)
	}
}
