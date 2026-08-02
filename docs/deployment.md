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
