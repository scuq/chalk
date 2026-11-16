-- chalk -- migration 0066 (136-4b: native push from the iOS shell)
--
-- A push subscription is now a Web Push registration of a browser or an APNs
-- registration of the iOS app. The new column kind tells them apart. It is
-- 'webpush' or 'apns'. Rows from before this migration become 'webpush'.
--
-- An APNs device is one row of the same table:
--   endpoint   the APNs device token, in lowercase hexadecimal
--   p256dh     the public key that the app made for itself
--   auth       the authentication secret that the app made for itself
--   vapid_key  the APNs subscription key, "<bundle id>/<environment>"
--
-- Because it is one table, the rules of phase 65 apply to both kinds. The
-- row belongs to the login session and ends with it. A session has one
-- subscription. A user has at most 8, and the oldest goes first. Guests have
-- none. The trigger of migration 0065 counts rows of both kinds.

ALTER TABLE push_subscriptions
  ADD COLUMN kind text NOT NULL DEFAULT 'webpush' CHECK (kind IN ('webpush', 'apns'));
