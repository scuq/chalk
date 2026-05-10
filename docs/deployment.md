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

## Backups

- **Postgres**: standard `pg_dump` or your managed service's snapshot
- **Blob volume**: rsync / object-storage replication
- **Recovery codes**: stored only as Argon2id hashes; no backup needed (and no way to recover them if lost)

## Upgrades

chalk migrations are idempotent and forward-only. Upgrade procedure:

1. Pull new image tag
2. Stop one chalkd instance
3. Run `chalkd --migrate-only` (added in phase 12) to apply migrations
4. Start the new instance
5. Roll the others

Down-version migrations are not provided. If you need to roll back, restore from snapshot.
