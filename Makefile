# chalk -- Makefile
#
# Primary developer entry point. Phase scripts in bootstrap/ do the project
# extension; this Makefile drives day-to-day build/run/test.

SHELL          := /usr/bin/env bash
.SHELLFLAGS    := -eu -o pipefail -c
.DEFAULT_GOAL  := help

# ---- Versioning ----------------------------------------------------------
GIT_SHA        := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_DIRTY      := $(shell test -n "$$(git status --porcelain 2>/dev/null)" && echo "-dirty" || echo "")
BUILD_DATE     := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
VERSION        ?= 0.0.0-dev

LDFLAGS := -s -w \
  -X github.com/scuq/chalk/internal/version.Version=$(VERSION) \
  -X github.com/scuq/chalk/internal/version.Commit=$(GIT_SHA)$(GIT_DIRTY) \
  -X github.com/scuq/chalk/internal/version.BuildDate=$(BUILD_DATE)

# ---- Targets -------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: build
build: ## Build the chalkd binary
	@mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/chalkd ./cmd/chalkd
	@echo "built: bin/chalkd ($(VERSION) $(GIT_SHA)$(GIT_DIRTY))"

.PHONY: run
run: build ## Build and run chalkd locally
	./bin/chalkd

.PHONY: test
test: ## Run all Go tests (unit + integration)
	go test -race -count=1 ./...

.PHONY: test-unit
test-unit: ## Run unit tests only (no Postgres)
	go test -race -count=1 -short ./...

.PHONY: vet
vet: ## go vet
	go vet ./...

.PHONY: fmt
fmt: ## gofmt
	gofmt -w -s .

.PHONY: lint
lint: vet ## All static checks
	@if command -v shellcheck >/dev/null 2>&1; then \
	  find bootstrap -name '*.sh' -print0 | xargs -0 shellcheck; \
	else \
	  echo "shellcheck not installed, skipping"; \
	fi

.PHONY: docker
docker: ## Build the container image
	docker build -f docker/Dockerfile -t chalk:dev --build-arg VERSION=$(VERSION) --build-arg GIT_SHA=$(GIT_SHA)$(GIT_DIRTY) .

.PHONY: docker-up
docker-up: ## docker compose up -d (dev stack)
	docker compose -f docker/docker-compose.yml up -d --build

.PHONY: docker-down
docker-down: ## docker compose down
	docker compose -f docker/docker-compose.yml down

.PHONY: docker-logs
docker-logs: ## Tail container logs
	docker compose -f docker/docker-compose.yml logs -f --tail=100

.PHONY: bootstrap
bootstrap: ## Run all phases (idempotent)
	bootstrap/run-all.sh

.PHONY: dev
dev: ## Bring up a full local stack (Postgres + chalkd + SPA) in foreground
	tools/dev.sh

.PHONY: dev-down
dev-down: ## Stop and remove the dev Postgres container
	@docker stop $${CHALK_DEV_PG_NAME:-chalk-dev-pg} >/dev/null 2>&1 || true
	@docker rm   $${CHALK_DEV_PG_NAME:-chalk-dev-pg} >/dev/null 2>&1 || true
	@echo "dev postgres container removed"

.PHONY: dev-logs
dev-logs: ## Tail the dev Postgres container logs
	docker logs -f --tail=100 $${CHALK_DEV_PG_NAME:-chalk-dev-pg}

# ---- dev mail (phase 09c) ------------------------------------------------
# Mailpit is a developer-facing SMTP sink: it accepts all incoming
# mail and exposes a web UI to inspect what was sent. chalkd is
# configured (via CHALK_SMTP_HOST=localhost CHALK_SMTP_PORT=1025)
# to deliver invite + email-change verification messages to it
# instead of stderr.
#
# Mailpit (axllent/mailpit) is the actively-maintained successor to
# Mailhog, with native multi-arch images (amd64, arm64, 386). We use
# it specifically because Mailhog never shipped an ARM64 build and
# requires QEMU emulation on Apple Silicon / ARM hosts.
#
# These targets are independent of `make dev`: run dev-mail-up before
# (or after) `make dev` and chalkd will start using it on next restart.
# If Mailpit isn't running, chalkd falls back to logging the message
# bodies to its own stderr.

CHALK_DEV_MAIL_NAME ?= chalk-dev-mailpit
CHALK_DEV_MAIL_SMTP_PORT ?= 1025
CHALK_DEV_MAIL_UI_PORT ?= 8025
CHALK_DEV_MAIL_IMAGE ?= axllent/mailpit:v1.21

.PHONY: dev-mail-up
dev-mail-up: ## Start a Mailpit container for dev (SMTP on 1025, UI on 8025)
	@if docker inspect $(CHALK_DEV_MAIL_NAME) >/dev/null 2>&1; then \
	  echo "$(CHALK_DEV_MAIL_NAME) already exists; starting it"; \
	  docker start $(CHALK_DEV_MAIL_NAME) >/dev/null; \
	else \
	  echo "creating $(CHALK_DEV_MAIL_NAME)"; \
	  docker run -d --name $(CHALK_DEV_MAIL_NAME) \
	    -p $(CHALK_DEV_MAIL_SMTP_PORT):1025 \
	    -p $(CHALK_DEV_MAIL_UI_PORT):8025 \
	    $(CHALK_DEV_MAIL_IMAGE) >/dev/null; \
	fi
	@echo "mailpit ready:"
	@echo "  smtp:  localhost:$(CHALK_DEV_MAIL_SMTP_PORT)"
	@echo "  ui:    http://localhost:$(CHALK_DEV_MAIL_UI_PORT)"
	@echo ""
	@echo "to point chalkd at mailpit, run with:"
	@echo "  CHALK_SMTP_HOST=localhost CHALK_SMTP_PORT=$(CHALK_DEV_MAIL_SMTP_PORT) make dev"

.PHONY: dev-mail-down
dev-mail-down: ## Stop and remove the dev Mailpit container
	@docker stop $(CHALK_DEV_MAIL_NAME) >/dev/null 2>&1 || true
	@docker rm   $(CHALK_DEV_MAIL_NAME) >/dev/null 2>&1 || true
	@echo "dev mailpit container removed"

.PHONY: dev-mail-logs
dev-mail-logs: ## Tail the dev Mailpit container logs
	docker logs -f --tail=100 $(CHALK_DEV_MAIL_NAME)

# ---- dev TURN relay (phase 30) --------------------------------------------
# coturn is the media relay chalk voice/video REQUIRES in practice: ~99% of
# real clients sit behind NAT that defeats P2P, so calls flow client ->
# coturn -> client as DTLS-SRTP ciphertext coturn cannot read (E2E intact;
# it authenticates allocations with short-lived HMAC creds minted by chalkd
# from the SHARED static secret -- see internal/turncred).
#
# Host networking is used because TURN allocates from a UDP RELAY PORT RANGE;
# per-port docker NAT for a range is slow and, worse, makes coturn advertise
# the container-internal IP in relayed candidates. Host networking sidesteps
# both. (Linux-only; on Docker Desktop for macOS use a real host instead.)
#
# These targets are independent of `make dev`: run dev-turn-up, then start
# chalkd with the printed CHALK_VOICE_* env to enable voice against it.

CHALK_DEV_TURN_NAME ?= chalk-dev-turn
CHALK_DEV_TURN_IMAGE ?= coturn/coturn:4
CHALK_DEV_TURN_SECRET ?= devsecret
CHALK_DEV_TURN_PORT ?= 3478
CHALK_DEV_TURN_MIN_PORT ?= 49160
CHALK_DEV_TURN_MAX_PORT ?= 49200
# Relay addressing (30-4 field fix). Under host networking coturn auto-picks
# a relay IP from the host's interfaces; on a VM (Parallels etc.) that address
# is often not hairpin-reachable, so relay-relay connectivity checks fail
# even though allocation succeeds. Two modes:
#   * loopback (default 1): pin listening+relay to 127.0.0.1 -- correct for
#     the common dev case of BOTH browsers on the same machine as coturn.
#     Requires --allow-loopback-peers: coturn DENIES loopback peer addresses
#     by default (CreatePermission -> 403), and with relay-ip=127.0.0.1 every
#     remote candidate IS a loopback peer. Dev-only; never use in prod.
#   * external: set CHALK_DEV_TURN_LOOPBACK=0 and CHALK_DEV_TURN_EXTERNAL_IP
#     to the VM's reachable address to test from other hosts; point
#     CHALK_TURN_URLS at that IP.
CHALK_DEV_TURN_LOOPBACK ?= 1
CHALK_DEV_TURN_EXTERNAL_IP ?=

.PHONY: dev-turn-up
dev-turn-up: ## Start a coturn container for dev voice (TURN on 3478, host networking)
	@if docker inspect $(CHALK_DEV_TURN_NAME) >/dev/null 2>&1; then \
	  echo "$(CHALK_DEV_TURN_NAME) already exists; starting it"; \
	  docker start $(CHALK_DEV_TURN_NAME) >/dev/null; \
	else \
	  echo "creating $(CHALK_DEV_TURN_NAME)"; \
	  docker run -d --name $(CHALK_DEV_TURN_NAME) \
	    --network host \
	    $(CHALK_DEV_TURN_IMAGE) \
	    --log-file=stdout \
	    --realm=chalk \
	    --use-auth-secret \
	    --static-auth-secret=$(CHALK_DEV_TURN_SECRET) \
	    --listening-port=$(CHALK_DEV_TURN_PORT) \
	    --min-port=$(CHALK_DEV_TURN_MIN_PORT) \
	    --max-port=$(CHALK_DEV_TURN_MAX_PORT) \
	    $(if $(filter 1,$(CHALK_DEV_TURN_LOOPBACK)),--listening-ip=127.0.0.1 --relay-ip=127.0.0.1 --allow-loopback-peers,) \
	    $(if $(CHALK_DEV_TURN_EXTERNAL_IP),--external-ip=$(CHALK_DEV_TURN_EXTERNAL_IP),) \
	    --fingerprint --no-cli --no-tls --no-dtls >/dev/null; \
	fi
	@echo "coturn ready:"
	@echo "  turn:  turn:localhost:$(CHALK_DEV_TURN_PORT)  (udp+tcp)"
	@echo "  relay: udp $(CHALK_DEV_TURN_MIN_PORT)-$(CHALK_DEV_TURN_MAX_PORT)"
	@if [ "$(CHALK_DEV_TURN_LOOPBACK)" = "1" ]; then \
	  echo "  mode:  loopback (127.0.0.1 only -- same-machine browsers)"; \
	else \
	  echo "  mode:  external$(if $(CHALK_DEV_TURN_EXTERNAL_IP), (--external-ip=$(CHALK_DEV_TURN_EXTERNAL_IP)),)"; \
	fi
	@echo ""
	@echo "to enable voice against it, run chalkd with:"
	@echo "  CHALK_VOICE_ENABLED=true \\"
	@echo "  CHALK_TURN_URLS=turn:localhost:$(CHALK_DEV_TURN_PORT) \\"
	@echo "  CHALK_TURN_SECRET=$(CHALK_DEV_TURN_SECRET) make dev"

.PHONY: dev-turn-down
dev-turn-down: ## Stop and remove the dev coturn container
	@docker stop $(CHALK_DEV_TURN_NAME) >/dev/null 2>&1 || true
	@docker rm   $(CHALK_DEV_TURN_NAME) >/dev/null 2>&1 || true
	@echo "dev coturn container removed"

.PHONY: dev-turn-logs
dev-turn-logs: ## Tail the dev coturn container logs
	docker logs -f --tail=100 $(CHALK_DEV_TURN_NAME)

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf bin/ dist/ coverage.*

.PHONY: clean-all
clean-all: clean ## Also remove bootstrap markers (forces rebuild of all phases)
	rm -rf .bootstrap

.PHONY: psql
psql: ## Connect to local dev database
	tools/psql.sh

.PHONY: reset-db
reset-db: ## Drop and recreate the dev database
	tools/reset-db.sh

