package store

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Session is one server-side opaque session token. Issued at the end
// of a successful registration or authentication ceremony, returned
// to the browser via Set-Cookie (HttpOnly, Secure, SameSite=Strict).
//
// The Token field carries the raw 32-byte secret. It's only populated
// when the session is fresh (CreateSession returns it) or when the
// caller is explicitly authenticating (GetSession). The token never
// appears in any wire frame except the Set-Cookie header.
//
// LastUsedAt is bumped on every authenticated request; the application
// is responsible for ensuring concurrent bumps don't fight (in
// practice, last_used_at updates from a single WS hello are well-
// serialized through the conn lifecycle).
type Session struct {
	Token       []byte // 32 random bytes
	UserID      uuid.UUID
	CreatedAt   time.Time
	LastUsedAt  time.Time
	ExpiresAt   time.Time
	UserAgent   string
	IPAddress   net.IP // may be nil
}

// SessionTTL is the sliding TTL applied at creation and at every
// successful TouchSession. Centralized so the auth layer has one
// place to read it from.
const SessionTTL = 30 * 24 * time.Hour

// NewSessionToken returns 32 cryptographically random bytes suitable
// for use as a session token. Reads from crypto/rand; returns an
// error only if the OS RNG fails, which should never happen in
// practice but is propagated up rather than panicked.
func NewSessionToken() ([]byte, error) {
	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		return nil, fmt.Errorf("session token: %w", err)
	}
	return tok, nil
}

// CreateSession persists a new session for userID and returns the
// fully-populated Session (including the raw token). The token is
// generated server-side; callers should never supply one.
//
// userAgent and ipAddress are optional metadata for the sessions
// panel (phase 09c). Both default to empty / nil when not available.
func (s *Store) CreateSession(
	ctx context.Context,
	userID uuid.UUID,
	userAgent string,
	ipAddress net.IP,
) (Session, error) {
	token, err := NewSessionToken()
	if err != nil {
		return Session{}, err
	}
	now := time.Now().UTC()
	expires := now.Add(SessionTTL)

	// Pass nil for INET when ipAddress is nil; pgx encodes nil as
	// SQL NULL for the inet type. A zero-length net.IP is treated
	// as "no address."
	var ipParam any
	if len(ipAddress) > 0 {
		ipParam = ipAddress.String()
	}
	// user_agent is similarly NULL-able.
	var uaParam any
	if userAgent != "" {
		uaParam = userAgent
	}

	_, err = s.Pool.Exec(ctx,
		`INSERT INTO sessions (token, user_id, created_at, last_used_at, expires_at, user_agent, ip_address)
		   VALUES ($1, $2, $3, $3, $4, $5, $6::text::inet)`,
		token, userID, now, expires, uaParam, ipParam,
	)
	if err != nil {
		return Session{}, fmt.Errorf("create session: %w", err)
	}
	return Session{
		Token:      token,
		UserID:     userID,
		CreatedAt:  now,
		LastUsedAt: now,
		ExpiresAt:  expires,
		UserAgent:  userAgent,
		IPAddress:  ipAddress,
	}, nil
}

// GetSession returns the session bound to the given raw token. Returns
// ErrNotFound for unknown tokens AND for sessions whose expires_at is
// in the past. The two cases are deliberately merged: callers should
// treat both as "no valid session."
//
// This method does NOT bump last_used_at; callers do that explicitly
// via TouchSession when they've confirmed they want to extend the
// session's TTL.
func (s *Store) GetSession(ctx context.Context, token []byte) (Session, error) {
	var sess Session
	var ipStr *string
	var userAgent *string
	err := s.Pool.QueryRow(ctx,
		`SELECT token, user_id, created_at, last_used_at, expires_at,
		        user_agent, host(ip_address)
		   FROM sessions
		  WHERE token = $1
		    AND expires_at > now()`,
		token,
	).Scan(
		&sess.Token,
		&sess.UserID,
		&sess.CreatedAt,
		&sess.LastUsedAt,
		&sess.ExpiresAt,
		&userAgent,
		&ipStr,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("get session: %w", err)
	}
	if userAgent != nil {
		sess.UserAgent = *userAgent
	}
	if ipStr != nil && *ipStr != "" {
		sess.IPAddress = net.ParseIP(*ipStr)
	}
	return sess, nil
}

// TouchSession bumps last_used_at and extends expires_at by SessionTTL.
// Idempotent; multiple concurrent touches from the same conn won't
// break anything. Returns ErrNotFound if the session is gone (e.g.
// revoked since the caller fetched it).
func (s *Store) TouchSession(ctx context.Context, token []byte) error {
	// SessionTTL is encoded as microseconds via the make_interval()
	// helper to avoid depending on pgx's time.Duration -> interval
	// encoding (which has varied across versions). microseconds is
	// the most precise unit make_interval() accepts and easily
	// represents our 30-day TTL.
	micros := SessionTTL / time.Microsecond
	tag, err := s.Pool.Exec(ctx,
		`UPDATE sessions
		    SET last_used_at = now(),
		        expires_at   = now() + make_interval(secs := $1::double precision / 1e6)
		  WHERE token = $2
		    AND expires_at > now()`,
		int64(micros),
		token,
	)
	if err != nil {
		return fmt.Errorf("touch session: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteSession removes a specific session. Idempotent: deleting an
// already-gone session is a no-op (no error). Used by logout and by
// admin block / soft delete (which calls DeleteAllSessionsForUser
// instead for the bulk path).
func (s *Store) DeleteSession(ctx context.Context, token []byte) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM sessions WHERE token = $1`, token,
	)
	if err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// DeleteAllSessionsForUser removes every session for the user. Used
// by "log out everywhere," admin block, soft delete, and (via the
// ON DELETE CASCADE on users.id) the underlying purge path.
// Returns the number of sessions deleted.
func (s *Store) DeleteAllSessionsForUser(ctx context.Context, userID uuid.UUID) (int64, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM sessions WHERE user_id = $1`, userID,
	)
	if err != nil {
		return 0, fmt.Errorf("delete all sessions: %w", err)
	}
	return tag.RowsAffected(), nil
}

// DeleteExpiredSessions removes sessions whose expires_at is in the
// past. Run periodically by a janitor. Returns the count deleted so
// the janitor can log it.
func (s *Store) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM sessions WHERE expires_at <= now()`,
	)
	if err != nil {
		return 0, fmt.Errorf("delete expired sessions: %w", err)
	}
	return tag.RowsAffected(), nil
}

// ListSessionsForUser returns sessions for a user, ordered by
// last_used_at descending (most recently active first). Returns
// only the metadata; the raw Token field on each Session is
// deliberately NOT populated (the caller may be the user themselves
// asking which sessions exist, and we don't want to leak revocation
// material). Callers that need the token use GetSession instead.
func (s *Store) ListSessionsForUser(ctx context.Context, userID uuid.UUID) ([]Session, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT user_id, created_at, last_used_at, expires_at,
		        user_agent, host(ip_address)
		   FROM sessions
		  WHERE user_id = $1
		    AND expires_at > now()
		  ORDER BY last_used_at DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()
	out := make([]Session, 0)
	for rows.Next() {
		var sess Session
		var ua *string
		var ip *string
		if err := rows.Scan(
			&sess.UserID,
			&sess.CreatedAt,
			&sess.LastUsedAt,
			&sess.ExpiresAt,
			&ua,
			&ip,
		); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		if ua != nil {
			sess.UserAgent = *ua
		}
		if ip != nil && *ip != "" {
			sess.IPAddress = net.ParseIP(*ip)
		}
		out = append(out, sess)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows: %w", err)
	}
	return out, nil
}
