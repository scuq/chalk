// chalk -- phase31-slice31-3 atomic TOTP verify/consume (store).
//
// The verify-and-consume for the mandatory second factor. The row lock lives
// here (this is the FOR UPDATE the 31-2 password path deferred): the replay
// guard (totp_last_step) and the lockout counters (failed_totp_count,
// locked_until) are read and written under a single FOR UPDATE so concurrent
// attempts cannot race. The crypto stays in the auth package -- passed in as
// the verify callback -- so the store never touches key material.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TOTPResult is the outcome of VerifyConsumeTOTP.
type TOTPResult int

const (
	// TOTPNotEnrolled: no user_auth row, or no confirmed TOTP secret.
	TOTPNotEnrolled TOTPResult = iota + 1
	// TOTPLocked: verification is currently locked out (too many failures).
	TOTPLocked
	// TOTPBadCode: code did not match (or was a replay); a failure was recorded.
	TOTPBadCode
	// TOTPSuccess: code matched a fresh step; last_step was advanced.
	TOTPSuccess
)

// VerifyConsumeTOTP atomically verifies a TOTP attempt for userID and updates
// replay/lockout state under FOR UPDATE.
//
// verify receives the stored (still-encrypted) secret and the current
// last-consumed step, and returns the matched step and whether any code in the
// skew window matched. Decryption and the HMAC comparison happen inside the
// callback (auth package); this method never sees plaintext key material.
//
// Semantics:
//   - no row / no confirmed secret            -> TOTPNotEnrolled
//   - locked_until in the future              -> TOTPLocked (lockedUntil set)
//   - match with step > last_step             -> TOTPSuccess (advance, reset fails)
//   - no match, or replay (step <= last_step) -> TOTPBadCode (increment fails;
//     at maxFailures set locked_until = now+lockout and reset the counter)
func (s *Store) VerifyConsumeTOTP(
	ctx context.Context,
	userID uuid.UUID,
	now time.Time,
	maxFailures int,
	lockout time.Duration,
	verify func(secretEnc []byte, lastStep int64) (matchedStep int64, ok bool),
) (result TOTPResult, lockedUntil time.Time, err error) {
	if maxFailures < 1 {
		maxFailures = 1
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		var (
			secret    []byte
			confirmed *time.Time
			lastStep  int64
			failed    int32
			locked    *time.Time
		)
		e := tx.QueryRow(ctx,
			`SELECT totp_secret_enc, totp_confirmed_at, totp_last_step,
			        failed_totp_count, locked_until
			   FROM user_auth WHERE user_id = $1 FOR UPDATE`,
			userID,
		).Scan(&secret, &confirmed, &lastStep, &failed, &locked)
		if errors.Is(e, pgx.ErrNoRows) {
			result = TOTPNotEnrolled
			return nil
		}
		if e != nil {
			return fmt.Errorf("select user_auth for update: %w", e)
		}
		if len(secret) == 0 || confirmed == nil {
			result = TOTPNotEnrolled
			return nil
		}
		if locked != nil && locked.After(now) {
			result = TOTPLocked
			lockedUntil = *locked
			return nil
		}

		matchedStep, ok := verify(secret, lastStep)
		if ok && matchedStep > lastStep {
			if _, e := tx.Exec(ctx,
				`UPDATE user_auth
				    SET totp_last_step = $2, failed_totp_count = 0, updated_at = now()
				  WHERE user_id = $1`,
				userID, matchedStep,
			); e != nil {
				return fmt.Errorf("totp success update: %w", e)
			}
			result = TOTPSuccess
			return nil
		}

		failed++
		if int(failed) >= maxFailures {
			lu := now.Add(lockout)
			if _, e := tx.Exec(ctx,
				`UPDATE user_auth
				    SET failed_totp_count = 0, locked_until = $2, updated_at = now()
				  WHERE user_id = $1`,
				userID, lu,
			); e != nil {
				return fmt.Errorf("totp lock update: %w", e)
			}
			lockedUntil = lu
		} else {
			if _, e := tx.Exec(ctx,
				`UPDATE user_auth
				    SET failed_totp_count = $2, updated_at = now()
				  WHERE user_id = $1`,
				userID, failed,
			); e != nil {
				return fmt.Errorf("totp failure update: %w", e)
			}
		}
		result = TOTPBadCode
		return nil
	})
	return result, lockedUntil, err
}
