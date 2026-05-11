# syntax=docker/dockerfile:1.7
#
# chalk -- Dockerfile
# Multi-stage build producing a distroless static binary image.
#
# Stages:
#   frontend: build the SPA bundle (npm + esbuild) into /web/dist
#   build:    compile chalkd against the bundle (Go embeds it)
#   runtime:  distroless image containing only the binary

# ---- Frontend stage ------------------------------------------------------
FROM node:20-alpine AS frontend

WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --prefer-offline --no-audit || npm install
# Copy the source after install so the install layer caches well.
COPY web/ ./
RUN npm run build

# ---- Build stage ---------------------------------------------------------
FROM golang:1.23-alpine AS build

WORKDIR /src

# Cache Go deps.
COPY go.mod go.sum* ./
RUN go mod download || true

# Copy source. The root-level embed.go declares package chalk and pulls
# in migrations/ + web/ via //go:embed; main.go imports the root module
# as `chalk "github.com/scuq/chalk"`, so all of these must be in the
# build context for the build to resolve.
COPY embed.go ./
COPY cmd ./cmd
COPY internal ./internal
COPY migrations ./migrations

# Copy the SPA tree from the frontend stage. We need the same web/
# directory layout the Go embed expects (web/dist/* plus web/index.html
# and friends -- but only the dist/ subdir is what the SPA handler
# serves; everything else under web/ is source).
#
# Simplest: copy web/ source first, then overlay dist/ from frontend.
COPY web/ ./web/
COPY --from=frontend /web/dist ./web/dist

ARG VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown

RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux GOARCH=$(go env GOARCH) \
    go build -trimpath \
      -ldflags="-s -w \
        -X github.com/scuq/chalk/internal/version.Version=${VERSION} \
        -X github.com/scuq/chalk/internal/version.Commit=${GIT_SHA} \
        -X github.com/scuq/chalk/internal/version.BuildDate=${BUILD_DATE}" \
      -o /out/chalkd ./cmd/chalkd

# Verify the binary actually runs in the build stage.
RUN /out/chalkd --version

# ---- Runtime stage -------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot

LABEL org.opencontainers.image.title="chalk"
LABEL org.opencontainers.image.description="End-to-end encrypted group chat"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/scuq/chalk"

COPY --from=build /out/chalkd /chalkd

USER nonroot:nonroot
EXPOSE 8443

# Healthcheck via the binary itself; distroless has no shell, so we use
# the docker-compose-level healthcheck instead. Documented in compose.yml.

ENTRYPOINT ["/chalkd"]
