-- chalk -- migration 0062 (129-2: instance settings)
--
-- One row per administrator-set switch that applies to the whole server and
-- is changed at run time from the admin panel, not from the environment at
-- boot. The first key is seasonal_decorations: whether the seasonal figure
-- (a ghost at halloween) shows for everyone on this server. No seed row:
-- an absent key means its default, and each default lives in the handler
-- (internal/auth/admin_settings_http.go), so a server upgraded to this
-- migration behaves as if the switch had always been on.
--
-- Plaintext on purpose, like the avatar frame (0061): a setting about how the
-- instance presents itself is not content, and GET /api/auth/config exposes it
-- before sign-in so the client never flashes a figure the administrator has
-- turned off.

CREATE TABLE instance_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
