-- chalk -- migration 0067 (139-1: the review instance for app review)
--
-- One row in review_instance marks this database as the database of a review
-- instance. This migration makes the table and leaves it empty, on every
-- database. Only `chalkctl review init` writes the row, on the review
-- database. No migration and no HTTP endpoint writes it.
--
-- chalkd turns on review mode only if CHALK_REVIEW_MODE is set AND the row
-- exists. If CHALK_REVIEW_MODE is set and the row does not exist, chalkd
-- does not start. The CHECK keeps the table at one row at most.

CREATE TABLE review_instance (
  id        boolean     PRIMARY KEY DEFAULT true CHECK (id),
  marked_at timestamptz NOT NULL DEFAULT now()
);
