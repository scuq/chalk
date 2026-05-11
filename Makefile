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
