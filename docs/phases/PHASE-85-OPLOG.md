# Phase 85 — Operational logging

Making a running chalk deployment legible to the person who operates it.
Written after 85-4, against v0.7.0.

**Status: 85-1 … 85-4 landed.** No migration, no wire frame, no client change.
Three `CHALK_OPLOG_*` knobs on chalkd plus one always-on access log in the
`chalkctl`-generated Caddyfile. Open items are at the end.

---

## The problem

chalkd is nearly silent once it is up: it prints its configuration and then
nothing but internal errors. That is a virtue right up to the first thing that
goes wrong on a self-hosted box nobody can attach a debugger to, and then it is
the whole problem:

- **An account that will not log in.** A TOTP lockout is invisible from the
  server side. The operator hears about it from the person locked out, hours
  later, with no way to tell a lockout from a forgotten password from a rate
  limit.
- **A login flood.** Rate limiting worked and said nothing. The response body is
  deliberately uninformative, so a sustained guessing attack and a quiet night
  produced identical logs — none.
- **"chalk feels slow."** No way to tell a slow client from a slow request from
  a database that is queueing acquires.
- **Requests chalkd never sees.** Redirects, ACME traffic, anything Caddy turns
  away at the edge, the maintenance notice itself. chalkd cannot log what never
  reached it, and Caddy logs only its own errors unless told otherwise.

## The rule the whole phase is built on

**Log volume must be bounded by something other than traffic.** Every line this
phase adds is either rare by construction, throttled, timer-driven, or
conditional on something already being wrong. Nothing logs per message, per
frame, or per healthy request. A log that grows with load fills a disk on the
day the operator most needs to read it — and on a small box, a log that costs
throughput is not a diagnostic worth having.

The second rule: **the line says what happened, to whom, and from where, and
nothing else.** No codes, no proofs, no tokens, no session material. A log file
is not a place to put something that was secret a moment ago.

## What ships

| | |
|---|---|
| 85-1 | Security events. `internal/config/oplog.go` (the three knobs, defaults, validation), `internal/auth/security_log.go` (`secLog` / `secLogThrottled` / `clientIPString`) and call sites across the auth surface. `chalkctl` writes the knobs into new env files and backfills existing ones on `update`. |
| 85-2 | The opt-in connection snapshot. `internal/server/oplog.go` (`snapshotLoop`, `logSnapshot`, `dbHealth`), `Conn.RemoteIP` / `Conn.Username` / `Conn.SetRTT` in `hub.go`, populated in `ws.go`. |
| 85-3 | The slow-request line. `slowRequestLogger` + `statusWriter` in `internal/server/oplog.go`, wrapped around the mux in `server.go`. |
| 85-4 | Caddy access log. A site-level `log` block in `internal/chalkctl/templates/Caddyfile.tmpl` (and the compose example), plus the **Logs** section in `docs/deployment.md`. |

## Design

### The knobs

`OplogConfig` (`internal/config/oplog.go`), read from `CHALK_OPLOG_*` with the
same "unset or unparseable leaves the default" contract as the rest of config:

| Env | Default | |
|---|---|---|
| `CHALK_OPLOG_SECURITY` | `true` | authentication outcomes |
| `CHALK_OPLOG_SNAPSHOT_INTERVAL` | `0` (off) | who is connected, on a timer |
| `CHALK_OPLOG_SLOW_REQUEST` | `2s` | one line per slow request; `0` disables |

`Validate` fences both durations. The snapshot floor — `0` or `>= 1m` — is the
interesting one: the snapshot walks every connection and pings the database, so
a ten-second interval turns a diagnostic into a log flood *plus* standing load.

chalkd prints `oplog: security_events=… conn_snapshot=… slow_request=…` at
startup, so an operator reading a quiet log can tell "nothing happened" from
"nothing is being recorded". That distinction is the reason the line exists.

### Security events (85-1, on by default)

Two emitters. `secLog` is for events that cannot be provoked in a loop — a
lockout arming, a successful login, an attempt against a blocked or deleted
account — and logs unthrottled. `secLogThrottled` is for events whose rate an
attacker controls, at **one line per key per five minutes**.

The key shape is the design: `"<event>|<ip>"` or `"<event>|<user>"`, so a flood
from one address cannot mask a first offence from another.

- `login_failed` throttles **by address, not by username**. A spray across many
  usernames from one host is one attacker and should read as one line, while the
  same username failing from a second address is a separate fact that deserves
  its own.
- `totp_locked` throttles by user: every attempt during a lockout window lands
  there, and that window is minutes long by design.
- `totp_lockout_armed` does **not** throttle. It fires once per
  `CHALK_TOTP_MAX_FAILURES` and it is the exact line an operator is looking for
  when a user says they cannot get in.
- `rate_limited` throttles per (bucket, IP), and covers the anon, recovery and
  guest-join limiters. Silent throttling is the hardest kind of production
  problem to diagnose.

The lines carry the client IP — that is the point; "someone is guessing
passwords" without an address is not actionable — resolved through
`auth.IPFromRequest`, so a deployment behind `chalkctl`'s Caddy logs the client
rather than the proxy. Usernames are logged as typed. A username is not a
secret, the caller supplied it, and without it the line cannot distinguish a
person fumbling their own password from an enumeration sweep.

The throttle limiter is built in `initSecurityLog`, called from
`initAnonLimiters`, so no request path can find it nil.

### Connection snapshot (85-2, off by default)

One summary line (`conns`, `users`, `guests`, db health) plus one line per live
connection: user, device type, remote IP, connection age, WebSocket round-trip,
guest marker. Connections are sorted by username so consecutive snapshots can be
diffed by eye — the hub's maps iterate in randomized order, which would make an
unchanged set look different every interval.

**Off by default is a privacy decision, not a cost one.** chalk encrypts message
content end-to-end; a rolling record of which account was online, when, and from
which address is precisely the metadata that survives that encryption, and it
would sit in an unencrypted log with a longer retention than anyone intends. An
operator who wants it can have it. No deployment gets it by accident.

Nothing here measures anything the server was not already doing: the round-trip
comes from the keepalive ping that already waits for its pong (one atomic store
per ping interval, one atomic load per snapshot), the pool counters are
maintained by pgx whether or not anyone reads them, `Conn.Username` reuses the
handle the welcome frame already looked up, and the database round-trip is one
ping per interval rather than per request.

`pool_waits` (pgx's `EmptyAcquireCount`) is the field to watch: non-zero and
growing means requests are queueing for a connection, which is the shape a
"chalk feels slow" report usually has. A failed ping logs `db=unreachable`,
which is worth saying out loud — the server is up and holding connections while
its database is not answering.

### Slow requests (85-3, on by default at 2s)

`slowRequestLogger` costs a `time.Now` and a comparison per request and produces
no output at all on a healthy server. A zero threshold returns the handler
untouched, so the disabled case costs not even a wrapper frame.

Two details worth keeping:

- **`/ws` is handed through untouched.** A WebSocket is "slow" by definition —
  it lives as long as the tab is open — so timing it would produce one useless
  line per disconnect, and wrapping its `ResponseWriter` would hide the hijack
  the upgrade depends on.
- **`statusWriter` implements `Unwrap`**, so `http.ResponseController` reaches
  the real writer and flushing still works.

2s was picked so that no request chalk makes on purpose reaches it: an Argon2id
login pass is ~200ms and the largest attachment finalize is well under a second.
A line here always means something is actually wrong.

### Caddy access log (85-4, on, no knob)

A site-level `log { output stderr / format json }` block, placed **above** the
maintenance mode switch in `Caddyfile.tmpl` so both modes log — a maintenance
window is exactly when an operator wants to see what is still arriving.

stderr is what podman hands to journald, so this lands in `journalctl -u
chalk-caddy` with the rest of the stack and inherits journald's retention
instead of growing a file nobody rotates. Caddy redacts Cookie, Set-Cookie and
Authorization by default; the global `log_credentials` option un-redacts them
and must never be added (a test asserts it is absent as a directive).

This is the one part of the phase that is **not** volume-bounded — it is one
line per request by definition. That is the trade the edge log exists to make,
and it is why `docs/deployment.md` says to set journald retention deliberately
rather than inherit the host default, and notes that journald's own rate
limiting drops messages under a flood rather than blocking Caddy (so the log is
not evidence-grade during an incident).

Placement has one consequence worth remembering: the Caddyfile is regenerated by
`chalkctl init` and by the `maint` toggle, but **not** by `chalkctl update`. An
existing deployment picks the access log up on the next `chalkctl init --force`.

### chalkctl

New deployments get all three knobs from `chalk.env.tmpl`, with the comments
that say what each one does. Existing deployments get them backfilled on
`chalkctl update` by `ensurePhase85Env`, each written with the value chalkd
would have assumed anyway — *the point is to put the knob in front of the
operator*, because a knob nobody knows about is a knob nobody turns on.

`CHALK_OPLOG_SNAPSHOT_INTERVAL` is backfilled as an explicit `0` rather than
left empty: empty reads as absent to `appendEnvVar`, so an empty backfill would
append the same line on every update.

## What is deliberately not logged

- Message content or ciphertext, in any form, anywhere.
- Anything per-message or per-frame.
- TOTP codes, auth proofs, session tokens, recovery phrases — nothing that was
  secret a moment before it reached the log.
- Successful requests under the threshold. A healthy chalkd stays quiet; a
  healthy Caddy does not, and that is the one asymmetry in the phase.

## Verification

`go test ./...`. Test files, all added with their slice:

| | |
|---|---|
| `internal/config/oplog_test.go` | defaults, env overlay, the duration parser, the snapshot floor |
| `internal/auth/security_log_test.go` | the throttle window, key isolation, the off switch |
| `internal/server/oplog_test.go` | snapshot formatting and sort order, `Conn.RTT`, duration rendering, the slow-request threshold, the disabled case, the default status, the `/ws` bypass |
| `internal/chalkctl/oplog_test.go` | the env template carries the knobs; `ensurePhase85Env` backfills once, is idempotent, and never overwrites an operator's edited value |
| `internal/chalkctl/maint_test.go` | 85-4: the log block survives the mode switch, `log_credentials` is absent, and — against a real Caddy in docker — two requests actually produce `"msg":"handled request"` and the `/healthz` URI in the container log |

That last one matters more than its size suggests: rendering a `log` block
proves nothing about whether Caddy writes anything.

## Open items

- **No live-stack exercise of the snapshot.** `logSnapshot` is unit-tested
  against constructed connections, but `dbHealth` has no test at all — it needs
  a real pool — and the RTT plumbing (`SetRTT` from the real ping loop) has
  never been watched end to end. Worth one run with
  `CHALK_OPLOG_SNAPSHOT_INTERVAL=1m` and two browsers before a release carries
  this: check that the RTT column is populated rather than `?`, and that
  `pool=` / `pool_waits=` read plausibly.
- **The Caddy access log has no off switch.** Hand-editing
  `/etc/chalk/caddy/Caddyfile` survives only until the next regeneration. A real
  knob has to ride in `state.json` the way `Maintenance` does, because
  `writeCaddyfile` deliberately supplies only `Domain`, `Maintenance` and
  `MaintenanceMessage` — pinned by a test, since any other field would render
  empty on every `maint` toggle. That is a slice of its own if an operator asks
  for it.
- **`chalkctl update` does not re-render the Caddyfile**, so 85-4 reaches
  existing deployments only via `init --force`. Making `update` re-render it
  would also clobber operator hand-edits to a file whose header says not to
  make them; left alone on purpose, documented instead.
- **Nothing rotates or ships these logs.** Retention is journald's
  (`SystemMaxUse`, `MaxRetentionSec`), which is the right default for a
  single-box deployment and the wrong one for anybody who wants to keep a
  security trail. No log shipping, no structured sink, no alerting — out of
  scope here, and the JSON access log is the format that would feed one.
