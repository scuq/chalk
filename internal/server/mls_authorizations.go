package server

// Phase 11c-1 PR 3: in-memory authorization cache for MLS membership
// changes.
//
// PR 2 introduced add_to_channel and remove_from_channel handlers
// that authorize a membership change without performing it. PR 3
// extends mls_commit_bundle to actually perform the change, and to
// validate the declared ProposedAdds/ProposedRemoves against what
// was previously authorized. This file holds that cross-handler
// state.
//
// Why an in-memory cache rather than a DB table:
//
// The cache lives for 60 seconds at most. Writing every
// authorization to PG would generate a write per add/remove plus a
// read per commit_bundle -- doubling DB traffic for negligible
// benefit. The data is transient and trivially reconstructible:
// if the cache is lost (chalkd restart), the client just calls
// add_to_channel again. Compare to PR 1's mls_commits, which
// MUST persist because clients can be offline arbitrarily long
// and must catch up on reconnect.
//
// Multi-instance caveat: this cache is per-chalkd-process. In a
// multi-chalkd deployment, the authorize call must land on the
// same chalkd as the follow-up commit_bundle. Chalk's existing
// session pinning (a user's connections are routed to the chalkd
// holding their session) makes this work for single-tab users.
// For multi-tab (the user authorized on tab A, then committed
// from tab B) within the same chalkd instance, both tabs share
// this cache so it's fine. For multi-tab across chalkds (rare
// but possible if instances are sharded by something other than
// user_id), this falls apart; see future-hardening note in
// design doc 11c §9.
//
// Subtle point: an authorization is single-use. Consume() removes
// the entry. Two add_to_channel calls followed by one commit_bundle
// will leave the second authorization sitting unused; it ages out
// in 60s. This matches the design intent ("one auth, one commit")
// and prevents a malicious or buggy client from authorizing once
// and committing several times.

import (
	"sync"
	"time"
)

// AuthKind discriminates between add and remove authorizations.
// Adding alice and removing alice from the same channel are
// independent authorizations.
type AuthKind string

const (
	AuthKindAdd    AuthKind = "add"
	AuthKindRemove AuthKind = "remove"
)

// authKey is the cache key. Three fields, all required.
type authKey struct {
	channelID string // UUID string form for cheap == comparison
	targetID  string
	kind      AuthKind
}

// MlsAuthorizationStore is an in-memory cache of recently issued
// add/remove authorizations. Safe for concurrent use.
//
// All entries have a fixed TTL (60s). Consume() returns true iff an
// entry exists AND has not expired; on success it removes the entry
// so it cannot be reused.
type MlsAuthorizationStore struct {
	mu      sync.Mutex
	entries map[authKey]time.Time // key -> creation timestamp
	ttl     time.Duration
	now     func() time.Time // overridable for tests
}

// NewMlsAuthorizationStore constructs an empty cache with the
// default 60s TTL.
func NewMlsAuthorizationStore() *MlsAuthorizationStore {
	return &MlsAuthorizationStore{
		entries: make(map[authKey]time.Time),
		ttl:     60 * time.Second,
		now:     time.Now,
	}
}

// Record stores an authorization for (channelID, targetID, kind).
// If an authorization already exists for the same key, it is
// overwritten (second call wins). This matches the intuition that
// a user who calls add_to_channel twice in a row gets the second
// authorization, not both.
func (s *MlsAuthorizationStore) Record(channelID, targetID string, kind AuthKind) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[authKey{channelID, targetID, kind}] = s.now()
}

// Consume removes and returns true if a non-expired authorization
// exists for (channelID, targetID, kind). On false, no state
// changes (the entry, if expired, is left for the sweeper or for
// a future overwriting Record).
//
// Single-use semantics: a successful Consume returns true exactly
// once; a second Consume for the same key returns false.
func (s *MlsAuthorizationStore) Consume(channelID, targetID string, kind AuthKind) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := authKey{channelID, targetID, kind}
	createdAt, ok := s.entries[k]
	if !ok {
		return false
	}
	if s.now().Sub(createdAt) > s.ttl {
		// Expired. Garbage-collect it now since we noticed.
		delete(s.entries, k)
		return false
	}
	delete(s.entries, k)
	return true
}

// Sweep removes all expired entries. Optional maintenance; the
// cache is self-cleaning on Consume but a periodic sweep prevents
// unbounded growth in pathological cases (lots of authorizations
// with no matching commits).
//
// Returns the number of entries removed. Not called automatically;
// the caller can wire a goroutine to invoke it on a timer if
// desired. For chalkd's traffic profile (handful of channel ops
// per minute), the cache shouldn't grow large enough to matter.
func (s *MlsAuthorizationStore) Sweep() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	removed := 0
	for k, createdAt := range s.entries {
		if now.Sub(createdAt) > s.ttl {
			delete(s.entries, k)
			removed++
		}
	}
	return removed
}

// Len returns the current number of entries (including expired
// ones not yet swept). Test-only; not exported via a typed
// signature beyond what's needed.
func (s *MlsAuthorizationStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}
