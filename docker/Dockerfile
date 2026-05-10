# syntax=docker/dockerfile:1.7
#
# chalk -- Dockerfile
# Multi-stage build producing a distroless static binary image.

# ---- Build stage ---------------------------------------------------------
FROM golang:1.23-alpine AS build

WORKDIR /src

# Cache deps
COPY go.mod go.sum* ./
RUN go mod download || true

# Copy source
COPY cmd ./cmd
COPY internal ./internal

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

# Verify the binary actually runs in the build stage
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
