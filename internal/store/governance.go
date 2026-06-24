package store

// gov-1a: the governance engine's data layer -- per-channel config, the frozen
// eligibility snapshot, proposal/vote primitives, and the pure tally evaluator.
// No wire/handler surface here (that is gov-1b); these are the store primitives
// the handlers will call, plus EvaluateTally, the pure (DB-free, unit-tested)
// heart of the resolve-on-certainty math.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ---- constants -------------------------------------------------------------

// Governance modes (channels.governance_mode).
const (
	GovernanceModeDictator   = "dictator"
	GovernanceModeDemocratic = "democratic"
)

// Proposal types. The engine is type-agnostic; only the action dispatch
// (gov-1b) switches on these. Adding a type later = a new constant + a new
// action handler, nothing in the engine.
const (
	ProposalTypeRemoveMember  = "remove_member"
	ProposalTypeAddMember     = "add_member"
	ProposalTypeSetMode       = "set_mode"
	ProposalTypeDeleteMessage = "delete_message"
)

// Proposal statuses (proposals.status).
const (
	ProposalStatusOpen       = "open"
	ProposalStatusPassed     = "passed"
	ProposalStatusFailed     = "failed"
	ProposalStatusCancelled  = "cancelled"
	ProposalStatusPassedMoot = "passed_moot" // resolved pass but action was inapplicable at execution (H3)
)

// Votes (proposal_votes.vote).
const (
	VoteYes = "yes"
	VoteNo  = "no"
)

// maxOpenProposalsPerAuthor caps how many open proposals a single member may
// have authored in one channel at once (H5 anti-flood). Kept a constant for
// gov-1a; can be promoted to a per-channel column / set_config knob later.
const maxOpenProposalsPerAuthor = 2

// ---- errors ----------------------------------------------------------------

var (
	// ErrProposalNotFound: no proposal with that id.
	ErrProposalNotFound = errors.New("proposal not found")
	// ErrBelowFloor: the eligibility snapshot is smaller than min_eligible, so
	// the channel is too small/quiet for democratic governance right now.
	ErrBelowFloor = errors.New("not enough eligible voters to open a proposal")
	// ErrProposalExists: an open proposal for this (channel, type, target)
	// already exists (the one-open-per-target uniqueness guard).
	ErrProposalExists = errors.New("an open proposal for this target already exists")
	// ErrReproposeCooldown: a prior proposal for this (channel, type, target)
	// failed too recently (H5 cooldown).
	ErrReproposeCooldown = errors.New("this proposal is in its re-propose cooldown")
	// ErrTooManyOpenProposals: the author already has the max open proposals
	// in this channel (H5 rate limit).
	ErrTooManyOpenProposals = errors.New("too many open proposals authored by this user")
	// ErrNotEligible: the voter is not in the proposal's frozen eligibility
	// snapshot, so cannot cast a ballot.
	ErrNotEligible = errors.New("not eligible to vote on this proposal")
	// ErrProposalClosed: the proposal is no longer open (already resolved).
	ErrProposalClosed = errors.New("proposal is not open")
	// ErrBadVote: vote value other than yes/no.
	ErrBadVote = errors.New("vote must be yes or no")
)

// ---- types -----------------------------------------------------------------

// GovernanceConfig is the per-channel governance parameter set. It lives on the
// channel (seeded from server defaults at creation) and is frozen onto each
// proposal at creation so an in-flight vote's rules can't change underneath it.
type GovernanceConfig struct {
	Mode                   string
	VoteWindowDays         int
	VoteExpiryHours        int
	MinEligible            int
	QuorumPercent          int
	PassPercent            int
	SupermajorityPercent   int
	ReproposeCooldownHours int
}

// withDefaults returns a copy with any zero/blank field filled by the spec
// defaults, so a directly-constructed Store (tests) still produces valid
// channels even if GovDefaults was never set.
func (g GovernanceConfig) withDefaults() GovernanceConfig {
	if g.Mode == "" {
		g.Mode = GovernanceModeDictator
	}
	if g.VoteWindowDays <= 0 {
		g.VoteWindowDays = 30
	}
	if g.VoteExpiryHours <= 0 {
		g.VoteExpiryHours = 168
	}
	if g.MinEligible < 1 {
		g.MinEligible = 3
	}
	if g.QuorumPercent < 1 || g.QuorumPercent > 100 {
		g.QuorumPercent = 50
	}
	if g.PassPercent < 1 || g.PassPercent > 100 {
		g.PassPercent = 50
	}
	if g.SupermajorityPercent < 1 || g.SupermajorityPercent > 100 {
		g.SupermajorityPercent = 67
	}
	if g.ReproposeCooldownHours <= 0 {
		g.ReproposeCooldownHours = 168
	}
	return g
}

// Proposal is one governance question. The frozen tally params (WindowDays..
// SupermajorityPercent) are snapshotted from the channel config at creation.
type Proposal struct {
	ID                   uuid.UUID
	ChannelID            uuid.UUID
	Type                 string
	TargetID             *uuid.UUID
	Payload              []byte // raw JSON
	CreatedBy            uuid.UUID
	CreatedAt            time.Time
	ExpiresAt            time.Time
	Status               string
	ResolvedAt           *time.Time
	WindowDays           int
	MinEligible          int
	QuorumPercent        int
	PassPercent          int
	SupermajorityPercent int
}

// CreateProposalInput is everything needed to open a proposal. ExpiresAt and
// the frozen params are derived from the channel config inside CreateProposal;
// callers supply only the question.
type CreateProposalInput struct {
	ChannelID uuid.UUID
	Type      string
	TargetID  *uuid.UUID // subject member for remove/add; nil for set_mode
	Payload   []byte     // raw JSON; "{}" if nil
	CreatedBy uuid.UUID
}

// ---- the pure tally evaluator (DB-free; unit-tested) -----------------------

// TallyDecision is the outcome of evaluating a proposal's current votes.
type TallyDecision string

const (
	DecisionOpen TallyDecision = "open" // not yet decided; keep waiting
	DecisionPass TallyDecision = "pass"
	DecisionFail TallyDecision = "fail"
)

// TallyInput is the minimal set the math needs. Eligible is the FROZEN snapshot
// size (target already excluded). ThresholdPercent is the caller's chosen bar
// (pass_percent normally; supermajority for set_mode->dictator). Expired marks
// an at-or-after-expiry evaluation.
type TallyInput struct {
	Eligible         int
	Yes              int
	No               int
	QuorumPercent    int
	ThresholdPercent int
	Expired          bool
}

// TallyResult is the evaluation: the decision, whether it's LOCKED (decided
// before expiry by mathematical certainty), and the display counts.
type TallyResult struct {
	Eligible         int
	Yes              int
	No               int
	Voted            int
	QuorumPercent    int
	ThresholdPercent int
	TurnoutMet       bool
	Decision         TallyDecision
	Locked           bool
}

// EvaluateTally implements the hardened resolve-on-certainty math (spec H10).
//
// With a FROZEN snapshot of E eligible voters, Y yes and N no already cast
// (V = Y+N), R = E-V still un-cast:
//
//   - turnout is met when V*100 >= quorum*E. Turnout is monotonic (only grows),
//     so once met it stays met.
//   - a normal/super majority is "strictly greater than threshold percent of
//     the voters": Y*100 > threshold*V. (threshold=50 => yes>no; 67 => >2/3.)
//
// Early resolution fires ONLY when the result is LOCKED against every
// completion of the un-cast remainder (cast votes are taken as final for the
// lock test; they remain mutable while OPEN, but the lock asks whether the
// SILENT remainder could still change things):
//
//   - PASS now: turnout already met AND yes holds even if ALL remaining vote no
//     (Y*100 > threshold*E).
//   - FAIL now: yes can't reach the bar even if ALL remaining (E-N of them)
//     vote yes at full turnout ((E-N)*100 <= threshold*E).
//   - else OPEN until expiry; at expiry PASS iff turnout AND yes, else FAIL.
//
// This never resolves on a transient majority that the remainder could
// overturn, which is the race the mutable-vote + early-resolve combo otherwise
// creates.
func EvaluateTally(in TallyInput) TallyResult {
	E, Y, N := in.Eligible, in.Yes, in.No
	V := Y + N
	q, t := in.QuorumPercent, in.ThresholdPercent

	res := TallyResult{
		Eligible:         E,
		Yes:              Y,
		No:               N,
		Voted:            V,
		QuorumPercent:    q,
		ThresholdPercent: t,
		TurnoutMet:       E > 0 && V*100 >= q*E,
	}

	if E <= 0 {
		// Degenerate (should never happen: floor >= 1). Nothing can pass.
		if in.Expired {
			res.Decision = DecisionFail
		} else {
			res.Decision = DecisionOpen
		}
		return res
	}

	// Locked PASS: turnout met now, and yes survives the whole remainder voting no.
	if res.TurnoutMet && Y*100 > t*E {
		res.Decision = DecisionPass
		res.Locked = true
		return res
	}
	// Locked FAIL: even max achievable yes (E-N, at full turnout E) can't pass.
	if (E-N)*100 <= t*E {
		res.Decision = DecisionFail
		res.Locked = true
		return res
	}
	if in.Expired {
		yesMet := Y*100 > t*V
		if res.TurnoutMet && yesMet {
			res.Decision = DecisionPass
		} else {
			res.Decision = DecisionFail
		}
		return res
	}
	res.Decision = DecisionOpen
	return res
}

// thresholdFor picks the pass bar for a proposal: the supermajority for a
// democratic->dictator set_mode (dissolving democracy is harder, H4), else the
// normal pass percent.
func thresholdFor(p Proposal) int {
	if p.Type == ProposalTypeSetMode && proposalTargetsDictator(p.Payload) {
		return p.SupermajorityPercent
	}
	return p.PassPercent
}

// ---- per-channel governance config reads/writes ----------------------------

// GetChannelGovernance reads a channel's governance config columns.
func (s *Store) GetChannelGovernance(ctx context.Context, channelID uuid.UUID) (GovernanceConfig, error) {
	var g GovernanceConfig
	err := s.Pool.QueryRow(ctx,
		`SELECT governance_mode, vote_window_days, vote_expiry_hours, min_eligible,
		        quorum_percent, pass_percent, supermajority_percent, repropose_cooldown_hours
		   FROM channels WHERE id = $1`,
		channelID,
	).Scan(
		&g.Mode, &g.VoteWindowDays, &g.VoteExpiryHours, &g.MinEligible,
		&g.QuorumPercent, &g.PassPercent, &g.SupermajorityPercent, &g.ReproposeCooldownHours,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return GovernanceConfig{}, ErrChannelNotFound
		}
		return GovernanceConfig{}, fmt.Errorf("get channel governance: %w", err)
	}
	return g, nil
}

// SetGovernanceMode updates a channel's governance_mode. The mode-change AUTHZ
// (dictator->democratic unilateral; democratic->dictator via supermajority
// set_mode) lives in the gov-1b handlers; this is the bare store write.
func (s *Store) SetGovernanceMode(ctx context.Context, channelID uuid.UUID, mode string) error {
	if mode != GovernanceModeDictator && mode != GovernanceModeDemocratic {
		return fmt.Errorf("invalid governance mode: %q", mode)
	}
	ct, err := s.Pool.Exec(ctx,
		`UPDATE channels SET governance_mode = $2 WHERE id = $1`,
		channelID, mode,
	)
	if err != nil {
		return fmt.Errorf("set governance mode: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrChannelNotFound
	}
	return nil
}

// ---- proposal lifecycle primitives -----------------------------------------

// CreateProposal opens a proposal: it freezes the channel's governance params
// onto the row, materializes the eligibility snapshot (active members within
// the window, excluding the sanction target for remove_member), enforces the
// floor / cooldown / per-author rate limit / one-open-per-target uniqueness,
// inserts the proposal + snapshot, and auto-casts the opener's YES if they are
// eligible. Returns the created proposal and the frozen eligible count.
//
// Mode gating (dictator vs democratic) is the caller's concern (gov-1b): this
// primitive just builds a well-formed proposal.
func (s *Store) CreateProposal(ctx context.Context, in CreateProposalInput) (Proposal, int, error) {
	if in.ChannelID == uuid.Nil || in.CreatedBy == uuid.Nil || in.Type == "" {
		return Proposal{}, 0, errors.New("channel_id, created_by and type are required")
	}
	payload := in.Payload
	if len(payload) == 0 {
		payload = []byte("{}")
	}

	var (
		out      Proposal
		eligible int
	)
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// Frozen params come from the channel's current governance config.
		g, gErr := getChannelGovernanceTx(ctx, tx, in.ChannelID)
		if gErr != nil {
			return gErr
		}

		// H5 rate limit: cap open proposals authored by this user here.
		var openByAuthor int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM proposals
			  WHERE channel_id = $1 AND created_by = $2 AND status = 'open'`,
			in.ChannelID, in.CreatedBy,
		).Scan(&openByAuthor); err != nil {
			return fmt.Errorf("count open proposals: %w", err)
		}
		if openByAuthor >= maxOpenProposalsPerAuthor {
			return ErrTooManyOpenProposals
		}

		// H5 cooldown: block re-propose of a recently-FAILED (channel,type,target).
		cooldown := time.Duration(g.ReproposeCooldownHours) * time.Hour
		var recentFail bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(
			   SELECT 1 FROM proposals
			    WHERE channel_id = $1 AND type = $2
			      AND target_id IS NOT DISTINCT FROM $3
			      AND status = 'failed'
			      AND resolved_at IS NOT NULL
			      AND resolved_at > now() - $4::interval
			 )`,
			in.ChannelID, in.Type, in.TargetID, intervalString(cooldown),
		).Scan(&recentFail); err != nil {
			return fmt.Errorf("check cooldown: %w", err)
		}
		if recentFail {
			return ErrReproposeCooldown
		}

		// Freeze eligibility: active members within the window, target excluded
		// for a personal sanction (H2). Snapshot is the denominator for life.
		var excluded *uuid.UUID
		if in.Type == ProposalTypeRemoveMember {
			excluded = in.TargetID
		}
		voters, vErr := eligibleVotersTx(ctx, tx, in.ChannelID, g.VoteWindowDays, excluded)
		if vErr != nil {
			return vErr
		}
		eligible = len(voters)
		if eligible < g.MinEligible {
			return ErrBelowFloor
		}

		// Insert the proposal with frozen params + mandatory expiry.
		expiresAt := time.Now().Add(time.Duration(g.VoteExpiryHours) * time.Hour)
		row := tx.QueryRow(ctx,
			`INSERT INTO proposals
			   (channel_id, type, target_id, payload, created_by, expires_at,
			    window_days, min_eligible, quorum_percent, pass_percent, supermajority_percent)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
			 RETURNING id, channel_id, type, target_id, payload, created_by,
			           created_at, expires_at, status, resolved_at,
			           window_days, min_eligible, quorum_percent, pass_percent, supermajority_percent`,
			in.ChannelID, in.Type, in.TargetID, payload, in.CreatedBy, expiresAt,
			g.VoteWindowDays, g.MinEligible, g.QuorumPercent, g.PassPercent, g.SupermajorityPercent,
		)
		if err := scanProposal(row, &out); err != nil {
			if isUniqueViolation(err) {
				return ErrProposalExists
			}
			return fmt.Errorf("insert proposal: %w", err)
		}

		// Materialize the snapshot rows.
		for _, v := range voters {
			if _, err := tx.Exec(ctx,
				`INSERT INTO proposal_eligibility (proposal_id, voter_id) VALUES ($1, $2)`,
				out.ID, v,
			); err != nil {
				return fmt.Errorf("insert eligibility: %w", err)
			}
		}

		// Opener auto-votes yes IF eligible (FORK 7). The opener of a
		// remove_member targeting themselves is excluded, so won't be in the set.
		if _, ok := indexOf(voters, in.CreatedBy); ok {
			if _, err := tx.Exec(ctx,
				`INSERT INTO proposal_votes (proposal_id, voter_id, vote) VALUES ($1, $2, 'yes')`,
				out.ID, in.CreatedBy,
			); err != nil {
				return fmt.Errorf("auto-vote: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return Proposal{}, 0, err
	}
	return out, eligible, nil
}

// CastVote records (or changes) a voter's ballot. Authz: the voter MUST be in
// the proposal's frozen eligibility snapshot, and the proposal MUST be open.
// Mutable until resolution (UPSERT on the PK).
func (s *Store) CastVote(ctx context.Context, proposalID, voterID uuid.UUID, vote string) error {
	if vote != VoteYes && vote != VoteNo {
		return ErrBadVote
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(ctx,
			`SELECT status FROM proposals WHERE id = $1`, proposalID,
		).Scan(&status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrProposalNotFound
			}
			return fmt.Errorf("load proposal: %w", err)
		}
		if status != ProposalStatusOpen {
			return ErrProposalClosed
		}
		var eligible bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(
			   SELECT 1 FROM proposal_eligibility WHERE proposal_id = $1 AND voter_id = $2
			 )`,
			proposalID, voterID,
		).Scan(&eligible); err != nil {
			return fmt.Errorf("check eligibility: %w", err)
		}
		if !eligible {
			return ErrNotEligible
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO proposal_votes (proposal_id, voter_id, vote)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (proposal_id, voter_id)
			 DO UPDATE SET vote = EXCLUDED.vote, voted_at = now()`,
			proposalID, voterID, vote,
		); err != nil {
			return fmt.Errorf("cast vote: %w", err)
		}
		return nil
	})
}

// TallyProposal loads a proposal's frozen snapshot size + current vote counts
// and runs EvaluateTally, picking the supermajority bar for a set_mode->dictator
// proposal. `expired` forces an at-expiry evaluation regardless of the clock
// (gov-1b's sweeper passes true); otherwise it's derived from expires_at.
func (s *Store) TallyProposal(ctx context.Context, proposalID uuid.UUID) (Proposal, TallyResult, error) {
	var p Proposal
	row := s.Pool.QueryRow(ctx,
		`SELECT id, channel_id, type, target_id, payload, created_by,
		        created_at, expires_at, status, resolved_at,
		        window_days, min_eligible, quorum_percent, pass_percent, supermajority_percent
		   FROM proposals WHERE id = $1`,
		proposalID,
	)
	if err := scanProposal(row, &p); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Proposal{}, TallyResult{}, ErrProposalNotFound
		}
		return Proposal{}, TallyResult{}, fmt.Errorf("load proposal: %w", err)
	}

	var eligible, yes, no int
	if err := s.Pool.QueryRow(ctx,
		`SELECT
		   (SELECT count(*) FROM proposal_eligibility WHERE proposal_id = $1),
		   (SELECT count(*) FROM proposal_votes WHERE proposal_id = $1 AND vote = 'yes'),
		   (SELECT count(*) FROM proposal_votes WHERE proposal_id = $1 AND vote = 'no')`,
		proposalID,
	).Scan(&eligible, &yes, &no); err != nil {
		return Proposal{}, TallyResult{}, fmt.Errorf("count votes: %w", err)
	}

	res := EvaluateTally(TallyInput{
		Eligible:         eligible,
		Yes:              yes,
		No:               no,
		QuorumPercent:    p.QuorumPercent,
		ThresholdPercent: thresholdFor(p),
		Expired:          !p.ExpiresAt.IsZero() && time.Now().After(p.ExpiresAt),
	})
	return p, res, nil
}

// MarkProposalResolved sets a terminal status + resolved_at. Only transitions
// an OPEN proposal (idempotent/no-op if already resolved). Used by gov-1b's
// resolve dispatch and expiry sweeper.
func (s *Store) MarkProposalResolved(ctx context.Context, proposalID uuid.UUID, status string) error {
	switch status {
	case ProposalStatusPassed, ProposalStatusFailed, ProposalStatusCancelled, ProposalStatusPassedMoot:
	default:
		return fmt.Errorf("invalid terminal status: %q", status)
	}
	ct, err := s.Pool.Exec(ctx,
		`UPDATE proposals SET status = $2, resolved_at = now()
		  WHERE id = $1 AND status = 'open'`,
		proposalID, status,
	)
	if err != nil {
		return fmt.Errorf("resolve proposal: %w", err)
	}
	if ct.RowsAffected() == 0 {
		// Either not found or already resolved; distinguish for the caller.
		var exists bool
		if e2 := s.Pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM proposals WHERE id = $1)`, proposalID,
		).Scan(&exists); e2 != nil {
			return e2
		}
		if !exists {
			return ErrProposalNotFound
		}
		return ErrProposalClosed
	}
	return nil
}

// GetProposal returns a single proposal by id.
func (s *Store) GetProposal(ctx context.Context, proposalID uuid.UUID) (Proposal, error) {
	var p Proposal
	row := s.Pool.QueryRow(ctx,
		`SELECT id, channel_id, type, target_id, payload, created_by,
		        created_at, expires_at, status, resolved_at,
		        window_days, min_eligible, quorum_percent, pass_percent, supermajority_percent
		   FROM proposals WHERE id = $1`,
		proposalID,
	)
	if err := scanProposal(row, &p); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Proposal{}, ErrProposalNotFound
		}
		return Proposal{}, fmt.Errorf("get proposal: %w", err)
	}
	return p, nil
}

// ListProposalsForChannel returns proposals for a channel, newest first. When
// openOnly is true, only status='open' rows are returned; otherwise the full
// audit history (the spec keeps resolved proposals as a visible log).
func (s *Store) ListProposalsForChannel(ctx context.Context, channelID uuid.UUID, openOnly bool) ([]Proposal, error) {
	q := `SELECT id, channel_id, type, target_id, payload, created_by,
	             created_at, expires_at, status, resolved_at,
	             window_days, min_eligible, quorum_percent, pass_percent, supermajority_percent
	        FROM proposals WHERE channel_id = $1`
	if openOnly {
		q += ` AND status = 'open'`
	}
	q += ` ORDER BY created_at DESC`
	rows, err := s.Pool.Query(ctx, q, channelID)
	if err != nil {
		return nil, fmt.Errorf("list proposals: %w", err)
	}
	defer rows.Close()
	out := make([]Proposal, 0)
	for rows.Next() {
		var p Proposal
		if err := scanProposal(rows, &p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows.Err proposals: %w", err)
	}
	return out, nil
}

// ListExpiredOpenProposals returns open proposals past their expiry (the
// gov-1b sweeper resolves these). Bounded by limit.
func (s *Store) ListExpiredOpenProposals(ctx context.Context, limit int) ([]Proposal, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT id, channel_id, type, target_id, payload, created_by,
		        created_at, expires_at, status, resolved_at,
		        window_days, min_eligible, quorum_percent, pass_percent, supermajority_percent
		   FROM proposals
		  WHERE status = 'open' AND expires_at <= now()
		  ORDER BY expires_at ASC
		  LIMIT $1`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list expired proposals: %w", err)
	}
	defer rows.Close()
	out := make([]Proposal, 0)
	for rows.Next() {
		var p Proposal
		if err := scanProposal(rows, &p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows.Err expired: %w", err)
	}
	return out, nil
}

// ---- helpers ---------------------------------------------------------------

// scanProposal scans the 15 proposal columns (in the canonical SELECT order)
// into p. rowScanner (defined in users.go) is satisfied by both pgx.Row and
// pgx.Rows, so this serves single-row and list queries alike.
func scanProposal(row rowScanner, p *Proposal) error {
	return row.Scan(
		&p.ID, &p.ChannelID, &p.Type, &p.TargetID, &p.Payload, &p.CreatedBy,
		&p.CreatedAt, &p.ExpiresAt, &p.Status, &p.ResolvedAt,
		&p.WindowDays, &p.MinEligible, &p.QuorumPercent, &p.PassPercent, &p.SupermajorityPercent,
	)
}

// getChannelGovernanceTx is the tx-scoped twin of GetChannelGovernance.
func getChannelGovernanceTx(ctx context.Context, tx pgx.Tx, channelID uuid.UUID) (GovernanceConfig, error) {
	var g GovernanceConfig
	err := tx.QueryRow(ctx,
		`SELECT governance_mode, vote_window_days, vote_expiry_hours, min_eligible,
		        quorum_percent, pass_percent, supermajority_percent, repropose_cooldown_hours
		   FROM channels WHERE id = $1`,
		channelID,
	).Scan(
		&g.Mode, &g.VoteWindowDays, &g.VoteExpiryHours, &g.MinEligible,
		&g.QuorumPercent, &g.PassPercent, &g.SupermajorityPercent, &g.ReproposeCooldownHours,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return GovernanceConfig{}, ErrChannelNotFound
		}
		return GovernanceConfig{}, fmt.Errorf("get channel governance: %w", err)
	}
	return g, nil
}

// eligibleVotersTx computes the eligible voter set: active members of the
// channel seen within windowDays, optionally excluding one voter (the sanction
// target). This is the query materialized into the frozen snapshot.
//
// Semantic note: last_seen_at measures *connected recently*, not *posted
// recently*. For "who could actually vote," connect-time is the better signal
// (it counts present members, not just posters). Deliberate.
func eligibleVotersTx(ctx context.Context, tx pgx.Tx, channelID uuid.UUID, windowDays int, exclude *uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx,
		`SELECT cm.user_id
		   FROM channel_members cm
		   JOIN users u ON u.id = cm.user_id
		  WHERE cm.channel_id = $1
		    AND u.status = 'active'
		    AND u.last_seen_at >= now() - make_interval(days => $2)
		    AND ($3::uuid IS NULL OR cm.user_id <> $3)`,
		channelID, windowDays, exclude,
	)
	if err != nil {
		return nil, fmt.Errorf("query eligible voters: %w", err)
	}
	defer rows.Close()
	out := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan eligible voter: %w", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows.Err eligible: %w", err)
	}
	return out, nil
}

func indexOf(ids []uuid.UUID, want uuid.UUID) (int, bool) {
	for i, id := range ids {
		if id == want {
			return i, true
		}
	}
	return 0, false
}

// intervalString renders a duration as a Postgres interval literal in seconds.
func intervalString(d time.Duration) string {
	return fmt.Sprintf("%d seconds", int64(d.Seconds()))
}

// proposalTargetsDictator reports whether a set_mode payload requests dictator
// mode (the supermajority-gated direction). Tolerant of malformed JSON: only a
// well-formed {"mode":"dictator"} counts.
func proposalTargetsDictator(payload []byte) bool {
	var p struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return false
	}
	return p.Mode == GovernanceModeDictator
}
