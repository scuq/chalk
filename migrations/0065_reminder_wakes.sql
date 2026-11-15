-- chalk -- migration 0065 (87-7: reminder wake records)
--
-- One row per pending reminder of a user who has web push on. The row lets
-- the server send a push at the due time while chalk is closed. It holds the
-- user, a random reminder ID from the client, and the due time. It holds no
-- message, no channel and no text: the reminder itself stays in the sealed
-- prefs blob.
--
-- The rows exist only while the user has a push subscription. The trigger
-- below deletes them when the last subscription of the user goes away, by
-- any path: the unsubscribe frame, the prune of a dead endpoint, or the
-- cascade from a session that ended. It is deferred to the commit, so a
-- subscription that is replaced in one transaction does not empty the set.

CREATE TABLE reminder_wakes (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_id uuid NOT NULL,
  due_at      timestamptz NOT NULL,
  PRIMARY KEY (user_id, reminder_id)
);

CREATE INDEX reminder_wakes_due_idx ON reminder_wakes (due_at);

CREATE FUNCTION reminder_wakes_follow_push() RETURNS trigger AS $$
BEGIN
  DELETE FROM reminder_wakes w
   WHERE w.user_id = OLD.user_id
     AND NOT EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = OLD.user_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER reminder_wakes_follow_push
  AFTER DELETE ON push_subscriptions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reminder_wakes_follow_push();
