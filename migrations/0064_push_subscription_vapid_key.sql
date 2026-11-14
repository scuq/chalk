-- chalk -- migration 0064 (65-4: the VAPID key of a push subscription)
--
-- A browser binds each push subscription to the VAPID public key that the page gave it
-- (applicationServerKey). After `chalkctl push rotate-key` the push services
-- refuse every push to a subscription made with the old key. vapid_key holds
-- that key, base64url, so the sender skips such rows and the page sees that
-- its subscription is stale and subscribes again.
--
-- Rows from 0063 get the empty string, which matches no key. No such rows
-- exist outside test databases: nothing wrote the table before this slice.

ALTER TABLE push_subscriptions ADD COLUMN vapid_key text NOT NULL DEFAULT '';
