package auth

import (
	"errors"
	"os"
	"strings"
)

// 139-1: review mode. On a review instance for app review, password login
// gives a session without the TOTP step. Two gates must both be open: the
// CHALK_REVIEW_MODE env var and the row of review_instance in the database.

// ErrReviewModeUnmarked is the error of [ResolveReviewMode] when
// CHALK_REVIEW_MODE is set but the database is not marked as a review
// database.
var ErrReviewModeUnmarked = errors.New(
	"CHALK_REVIEW_MODE is set, but this database is not a review database " +
		"(table review_instance is empty). Remove CHALK_REVIEW_MODE, or use " +
		"the database that `chalkctl review init` made")

// ReviewModeRequested reports whether the CHALK_REVIEW_MODE env var asks for
// review mode. Any of "1", "true", "yes", "on" (case-insensitive) asks for
// it. Anything else does not.
func ReviewModeRequested() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("CHALK_REVIEW_MODE"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// ResolveReviewMode returns the review mode for chalkd from the two gates:
//
//   - requested false: false, nil, whatever marked is
//   - requested true, marked false: false, [ErrReviewModeUnmarked]
//   - requested true, marked true: true, nil
//
// chalkd does not start on the error.
func ResolveReviewMode(requested, marked bool) (bool, error) {
	if !requested {
		return false, nil
	}
	if !marked {
		return false, ErrReviewModeUnmarked
	}
	return true, nil
}

// ReviewModeBanner returns the line that chalkd logs at each start in review
// mode. The text is stable, so that log scrapers can match it.
func ReviewModeBanner() string {
	return "CHALK REVIEW MODE ENABLED: password login gives a session without the TOTP step"
}
