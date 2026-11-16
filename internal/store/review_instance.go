// 139-1: the mark of a review instance (migration 0067).

package store

import "context"

// IsReviewInstance reports whether the database has the row of
// review_instance. Only `chalkctl review init` writes that row, on the
// database of a review instance.
func (s *Store) IsReviewInstance(ctx context.Context) (bool, error) {
	var marked bool
	err := s.Pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM review_instance)`,
	).Scan(&marked)
	return marked, err
}
