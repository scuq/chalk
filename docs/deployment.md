# Deployment

## Local development

```sh
make docker-up      # postgres + chalk on http://127.0.0.1:8443
make docker-logs
make docker-down
```

For native Go development without Docker:

```sh
# In one terminal: postgres
docker run -d --name chalk-pg -p 5432:5432 \
  -e POSTGRES_DB=chalk -e POSTGRES_USER=chalk -e POSTGRES_PASSWORD=chalk \
  postgres:17-alpine

# In another:
export CHALK_DB_URL='postgres://chalk:chalk@127.0.0.1:5432/chalk?sslmode=disable'
export CHALK_TLS_MODE=off
make run
```

## Single-host production

```sh
docker compose -f docker/docker-compose.prod.yml up -d
```

Edit `docker/caddy/Caddyfile.example` first to set your domain. Caddy auto-issues Let's Encrypt certs.

Stack: 2× chalkd behind Caddy, single Postgres, named volumes for PG data and blob storage.

## Multi-host

Beyond a single host you'll want:

- Postgres on a managed service (or a separate host with replication)
- Multiple chalkd instances behind a load balancer with sticky sessions (IP hash or cookie-based)
- S3-compatible object storage (MinIO, R2, S3) instead of the host volume for blobs — this requires a code change in the blob handler, planned but not in v1

## Configuration reference

All flags are also available as `CHALK_*` env vars (e.g. `--listen` ↔ `CHALK_LISTEN`). Flags win over env, env wins over defaults.

| Flag | Env | Default | Notes |
|---|---|---|---|
| `--listen` | `CHALK_LISTEN` | `:8443` | |
| `--db-url` | `CHALK_DB_URL` | (required from phase 03) | |
| `--tls-mode` | `CHALK_TLS_MODE` | `selfsigned` | `off` / `selfsigned` / `file` / `autocert` |
| `--tls-cert` | `CHALK_TLS_CERT` | | required when `tls-mode=file` |
| `--tls-key` | `CHALK_TLS_KEY` | | required when `tls-mode=file` |
| `--autocert-host` | `CHALK_AUTOCERT_HOST` | | required when `tls-mode=autocert` |
| `--autocert-cache` | `CHALK_AUTOCERT_CACHE` | `/var/lib/chalk/autocert` | |
| `--blob-dir` | `CHALK_BLOB_DIR` | `/var/lib/chalk/blobs` | |
| `--log-level` | `CHALK_LOG_LEVEL` | `info` | |
| `--log-format` | `CHALK_LOG_FORMAT` | `console` | `console` / `json` |
| `--shutdown-grace` | `CHALK_SHUTDOWN_GRACE` | `20s` | |
| `--instance-id` | `CHALK_INSTANCE_ID` | (auto UUID) | |
| — | `CHALK_SERVER_ID_KEY` | (chalkctl-generated) | phase 83 server identity (Ed25519 seed, b64); see “Server identity” below |
| | `CHALK_VOICE_ENABLED` | `false` | phase 30: master switch for voice/video |
| | `CHALK_VOICE_MAX_PARTICIPANTS` | `5` | mesh room cap (2..16) |
| | `CHALK_VOICE_FORCE_RELAY` | `false` | test knob: clients use relay-only ICE |
| | `CHALK_TURN_URLS` | | comma-separated PUBLIC coturn URIs |
| | `CHALK_TURN_SECRET` | | shared with coturn `--static-auth-secret` |
| | `CHALK_TURN_TTL_SECS` | `3600` | minted-credential lifetime |
| | `CHALK_STUN_URLS` | | optional explicit STUN URIs |
| | `CHALK_VOICE_PROBE_ENABLED` | `true` | 30-8: pre-stream uplink probe (`POST /api/netprobe`) |
| | `CHALK_VOICE_PROBE_BYTES` | `3000000` | probe upload size / server-side body cap |
| | `CHALK_VOICE_RECHECK_SECS` | `60,360,660` | in-call replan ticks (passive getStats reads) |
| | `CHALK_VOICE_UPLINK_HEADROOM` | `0.85` | fraction of measured uplink the planner spends |
| | `CHALK_VOICE_AUDIO_KBPS` | `64` | per-peer voice reserve |
| | `CHALK_VOICE_MIN_VIDEO_KBPS` | `300` | per-copy floor before video is unsustainable |
| `--db-url-guest` | `CHALK_DB_URL_GUEST` | | phase 80: the `chalk_guest` pool; empty disables guest joins |
| | `CHALK_EPHEMERAL_ENABLED` | `false` | phase 80: ephemeral voice channels + guest links. Off unless asked for since 81-3; `chalkctl` writes your choice explicitly either way |
| | `CHALK_EPHEMERAL_MAX_TTL_HOURS` | `720` | cap on a room's lifetime (1 month) |
| | `CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS` | `24` | cap on a link's lifetime; values above 24 refuse to boot |
| | `CHALK_EPHEMERAL_MAX_GUESTS` | `8` | invite links per room (revoking frees a slot) |
| | `CHALK_TRUSTED_PROXY` | | CIDR list or `private`; X-Forwarded-For is honored only from these peers (set to `private` behind chalkctl's Caddy so per-IP rate limits see real clients). `chalkctl` generates this since 81-3 |
| | `CHALK_AUTH_DECOY_KEY` | | 32 bytes, standard base64. Keys the fake KDF params served for unknown usernames; unset means a per-process key, so decoys shift on restart while real accounts' params don't — which is itself the tell. `chalkctl` generates this since 81-3 |

## Voice (TURN relay)

Phase 30 voice/video treats **coturn as a mandatory media relay, not a
fallback**: in practice ~99% of clients sit behind NAT/firewalls that defeat
direct P2P, so calls flow client → coturn → client. The relay carries
**DTLS-SRTP ciphertext it cannot decrypt** — end-to-end encryption is
unaffected — and chalkd mints **short-lived HMAC credentials** (TURN REST
scheme) from the shared `CHALK_TURN_SECRET`, so a leaked credential expires
instead of living forever.

### Dev

```
make dev-turn-up          # coturn on host networking, secret "devsecret"
CHALK_VOICE_ENABLED=true \
CHALK_TURN_URLS=turn:localhost:3478 \
CHALK_TURN_SECRET=devsecret make dev
```

`make dev-turn-down` removes it; `make dev-turn-logs` tails allocations.

### Production

The prod compose ships a `coturn` service on **host networking** (a UDP relay
port *range* through docker NAT is slow and advertises container-internal IPs).
Required environment: `CHALK_TURN_SECRET` (any long random string; it is the
coturn `--static-auth-secret`) and `CHALK_TURN_URLS` set to the **public**
address clients can reach, e.g. `turn:chat.example.org:3478`. Then set
`CHALK_VOICE_ENABLED=true`.

Firewall: open `3478/tcp+udp` and the relay range `49160–49200/udp` (both
configurable via `CHALK_TURN_PORT` / `CHALK_TURN_MIN_PORT` / `CHALK_TURN_MAX_PORT`).

**Bandwidth sizing**: voice rooms are a client mesh relayed through coturn — a
room of N puts ~2×(N−1) media streams per active sender through the relay.
Small rooms (the default cap is 5) fit comfortably on a modest VPS; what
matters is *symmetric* bandwidth, roughly (participants × per-stream bitrate ×
2) at peak. A 1080p screen share tops out around 2.5 Mbps per viewer; budget
accordingly.

**TLS (`turns:`) hardening** (optional): some restrictive networks block plain
3478. coturn can additionally listen with TLS on 5349 — mount a cert/key pair
and add `--tls-listening-port=5349 --cert=/certs/fullchain.pem
--pkey=/certs/privkey.pem` to the coturn command (dropping `--no-tls`), then
append `turns:chat.example.org:5349?transport=tcp` to `CHALK_TURN_URLS`. The
media itself is E2E-encrypted either way; `turns:` only wraps the TURN control
channel. Reusing Caddy's certificates requires exporting them from the caddy
data volume on renewal — a renewal hook outside this compose file's scope.

**Secret rotation**: change `CHALK_TURN_SECRET`, restart coturn and chalkd.
In-flight calls survive until their minted credentials expire (default 1h);
new joins use the new secret immediately.

## Ephemeral voice channels (guest links)

Phase 80 (plan: `docs/phases/PHASE-80-EPHEMERAL.md`): a voice channel can be created
with an expiry, and its creator can mint **magic links** that let people
without an account join the call and its scratchpad. When the room expires,
everything it held — messages, guest accounts, links — is hard-deleted.

**Database roles.** The feature's security boundary is PostgreSQL: chalkd's
normal pool connects as `chalk_app` (non-superuser) and connections serving a
guest as `chalk_guest`, which is fenced by `FORCE ROW LEVEL SECURITY` to its
one channel and has *no grant at all* on sessions, auth, friendships or
attachments. `chalkctl init` creates both roles; **`chalkctl update` backfills
them automatically** on an existing deployment (new `chalk.env` keys:
`CHALK_PG_APP_PASSWORD`, `CHALK_PG_GUEST_PASSWORD`, `CHALK_DB_URL_GUEST`, and
`CHALK_DB_URL` repointed at `chalk_app`). `chalkctl restore` re-asserts the
roles before loading a dump — they live in the cluster, not the database.

**The link.** `https://<domain>/join/<lookup>#<secret>` — the fragment never
reaches the server, and everything the guest is (its keys, its space-key
wrap) is derived from it client-side. Whoever holds the link IS the guest,
which is why links are capped at 24 h. Links are minted from the room's
members panel (creator only), shown exactly once, and revocable.

**coturn peer fence.** Since guests get TURN credentials, the coturn unit now
denies relaying to private/special address ranges (`--denied-peer-ip`,
`--no-multicast-peers`) and carries `--total-quota` / `--max-bps`. Existing
deployments pick this up via `chalkctl reconfigure-turn` (or `init --force`);
verify with `systemctl cat chalk-coturn` and a real call — a malformed coturn
flag is silent.

**Operations:**

```bash
chalkctl ephemeral list                    # rooms, guests, links, calls
chalkctl ephemeral purge --channel <id>    # destroy one room now (confirmed)
chalkctl ephemeral purge                   # destroy every ephemeral room
chalkctl ephemeral disable                 # feature off + all links revoked
```

Purge works by expiring the room; chalkd's minutely janitor performs the
hard delete (one audited deletion path) and pushes the removal to connected
clients, kicking any guests still in the call.

## Server identity (phase 83)

Every client pins the server's Ed25519 identity — at registration for new
accounts, at first post-update login for existing ones — and proves it at
every connection through the inner sealed channel, so a MITM with a valid
TLS certificate still cannot answer for the server. The key is
`CHALK_SERVER_ID_KEY` in the env file: `chalkctl init` generates it,
`--force` preserves it, `update` backfills it on old deployments, and
`restore` carries it to a new host (a restored server must keep its
identity or every client stops at the pin wall).

    chalkctl serverkey show           # the fingerprint clients compare against

**Rotating it is an operator ceremony, never routine.** `chalkctl serverkey
rotate --yes` writes a fresh key and prints the new fingerprint; announce it
to your users out of band (not through chalk — the channel being re-keyed is
the one in doubt), then restart chalkd. Every client stops at a full-screen
wall showing the fingerprint it pinned and the one now presented; each user
compares the presented one against your announcement and chooses to trust
it. A client that sees a changed key you did NOT announce is looking at an
interception — that is the wall doing its job.

## Backups

```bash
chalkctl backup                       # -> /var/lib/chalk/backups/chalk-<domain>-<ts>.chalkbak
chalkctl backup --out /root/chalk.chalkbak
```

The archive is one password-encrypted file (Argon2id + AES-256-GCM, framed so
neither end has to hold the database in memory) containing:

- the **database** — every message, channel, membership, device and attachment.
  Attachment ciphertext is a `bytea` column, not a file, so the dump is the
  whole story; the `chalk-blobs` volume is unused.
- **chalk.env** — because `CHALK_TOTP_ENC_KEY` is the key the database's TOTP
  secrets are encrypted under. A database restored without it locks every
  account out at the second factor.
- **chalkctl.conf** — so a restore can report which knobs the old host had set.

Caddy's certificate volume is deliberately left out: a new host issues its own.

The password is supplied by `--password-file`, `$CHALK_BACKUP_PASSWORD`, or an
interactive prompt (asked twice). There is no recovery path if it is lost.
The stack keeps serving throughout — `pg_dump` reads a consistent snapshot.

- **Recovery codes**: stored only as Argon2id hashes; no backup needed (and no way to recover them if lost)

## Metrics

```bash
chalkctl metrics              # point-in-time: sizes, ratios, growth, bloat
chalkctl metrics --sample 30s # two readings, reported as rates
```

Everything comes out of Postgres' cumulative statistics views, which are
in-memory counters the server maintains whether anyone reads them or not.
Reading them costs a catalog lookup and no table I/O, so this is safe to run on
a busy host.

The exclusions are the point, and a test enforces them:

- **No `count(*)`.** Row counts come from `n_live_tup`, the planner's estimate.
  Counting twenty million messages to print one number would make this command
  the most expensive thing on the box.
- **No `pgstattuple` / `pg_buffercache`.** Both give better bloat and cache
  figures by reading every page of the table.
- **No `sum(octet_length(ciphertext))`.** Attachment volume comes from the
  partition's on-disk size instead.

What it reports, roughly in the order a slow server gets explained: database
size and cache hit ratio; connections, the longest transaction, and anything
idle-in-transaction (which blocks autovacuum database-wide); checkpoints forced
by WAL volume rather than the clock; tables being read start-to-finish
(the missing-index signal, with small tables excluded because scanning them is
the correct plan); dead rows autovacuum has not reclaimed; indexes never read;
growth per month; and the largest tables.

Growth per month is free: `messages` and `attachments` are partitioned monthly,
so the partition sizes *are* the growth curve — no history to store.

Counters are cumulative since the last stats reset, which answers "how big" but
not "how busy". `--sample 30s` takes two readings and subtracts them, which is
what you want while a problem is actually happening.

### Per-query timings

Which *statements* dominate total time needs `pg_stat_statements`, which is
off by default because it adds a small cost to every statement executed:

```bash
chalkctl init --force --pg-stat-statements   # restarts postgres
```

It goes on the Postgres container's command line as `shared_preload_libraries`,
which is why it needs a restart, and `init` creates the extension once the
server is back up. `chalkctl metrics` then grows a "queries by total time"
section. Turn it off again with `--pg-stat-statements=false` and another
`--force`.

## Logs

Every container logs to stdout/stderr, which podman hands to journald:

```bash
journalctl -u chalk-caddy -f          # HTTP access log + TLS/ACME
journalctl -u chalkd -f               # app log, security events, slow requests
journalctl -u chalk-postgres -u chalk-coturn
```

Caddy writes a **JSON access log for every request** (85-4), in normal and
maintenance mode alike: client IP, method, host, URI, status, duration, bytes
and request headers. It is the only record of requests chalkd never sees —
redirects, ACME traffic, the maintenance notice, anything rejected at the edge.
Cookie, Set-Cookie and Authorization headers are redacted by Caddy; do not add
its `log_credentials` global option, which un-redacts them.

Two consequences worth knowing:

- **It is a standing record of who connected from where**, at request
  granularity. chalk encrypts what people say, not the fact that they showed
  up. Journald retention is the retention (`SystemMaxUse` / `MaxRetentionSec`
  in `journald.conf`) — set it deliberately rather than inheriting whatever the
  host defaults to.
- Under a flood, journald's own rate limiting (`RateLimitIntervalSec` /
  `RateLimitBurst`) drops messages rather than blocking Caddy, so the log is
  not evidence-grade during an incident.

An existing deployment gets it when the Caddyfile is next regenerated, which
`chalkctl update` does **not** do — run `chalkctl init --force` (or toggle
maintenance mode) to pick it up.

There is no knob for it yet. Dropping the `log` block from
`/etc/chalk/caddy/Caddyfile` and reloading (`sudo podman exec caddy caddy
reload --config /etc/caddy/Caddyfile`) turns it off until the next thing that
regenerates that file — `chalkctl maint on`/`off` and `chalkctl init --force`
both write it back.

The app's own operational logging (security events, the connection snapshot,
slow requests) is separate and knob-controlled: see `CHALK_OPLOG_*` in
`internal/config/oplog.go`.

## Maintenance mode

```bash
chalkctl maint on --message "moving to a new server, back by 14:00 UTC"
chalkctl maint status
chalkctl maint off
```

Re-renders **only** the Caddyfile so Caddy answers every request itself with a
503 notice and `Retry-After`, then reloads Caddy in place (no dropped
connections; it falls back to restarting `chalk-caddy` if the reload fails).
Nothing else moves — not the units, the image pin, chalkd, or the database.
Caddy stays up, so the certificate keeps renewing while the app is down.

Without it, stopping chalkd leaves everyone on a bare Caddy 502.

Two deliberate exceptions to "Caddy answers everything":

- **`/healthz` still proxies to chalkd.** `update` and `restore` poll it to
  decide whether the app came back; if maintenance swallowed it they would
  health-check the notice and roll back a healthy deployment.
- **`init --force` preserves the mode.** You are in maintenance because work is
  in progress; a re-apply must not silently put the site back in front of
  users. `chalkctl status` prints a line whenever it is on, and only then.

The `--message` is a single line, HTML-escaped before it reaches the page (a
backtick is rejected outright — it would terminate the Caddyfile string).

## Moving to a new host

```bash
# old host
chalkctl maint on --message "moving to a new server, back by 14:00 UTC"
chalkctl backup --out /root/chalk.chalkbak
scp /root/chalk.chalkbak newhost:/root/

# new host: a normal fresh init first, so Caddy issues real certificates and
# the stack is proven healthy before any data is at stake
chalkctl init --domain chat.example.org --rootful \
    --admin-username <name> --admin-email <addr>
chalkctl restore /root/chalk.chalkbak
```

`restore` requires an initialized host and never touches the units, the
Caddyfile or the image pin. It replaces exactly two things: the contents of the
database, and `CHALK_TOTP_ENC_KEY` in the env file. Everything else init
generated stays — the new host's Postgres password, its TURN secret and its
`CHALK_RP_ID` all belong to the host actually serving.

It streams the archive in one pass: the manifest comes first, so you see the
source domain, version and backup date and confirm by typing the domain before
anything is written. The load runs as a single transaction, so a restore either
lands completely or leaves the database as it was. After it, `restore` prints
the deployment knobs the old host had that this one does not — adopting them
means re-running `chalkctl init --force` with the matching flags.

Once the new host is serving, `chalkctl maint off` on it (and point DNS across
if the domain moved). The old host can then be torn down.

**Keep the domain the same** if you can. Passkeys are bound to the RP ID, which
is the domain, so a rename invalidates them; everyone can still sign in with
password + TOTP and enrol a new passkey. Sessions, identities and message
history are unaffected either way. If the domain does change, DNS has to point
at the new host before `init`, or HTTP-01 cannot issue.

## Upgrades

chalk migrations are idempotent and forward-only. Upgrade procedure:

1. Pull new image tag
2. Stop one chalkd instance
3. Run `chalkd --migrate-only` (added in phase 12) to apply migrations
4. Start the new instance
5. Roll the others

Down-version migrations are not provided. If you need to roll back, restore from snapshot.
