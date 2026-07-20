// Package chalk embeds static assets (migrations, web SPA bundle) into
// the binary.
package chalk

import "embed"

// Migrations holds every .sql file in the migrations/ directory.
//
//go:embed migrations/*.sql
var Migrations embed.FS

// MigrationsDir is the directory name inside the embedded FS.
// migrate.Load needs both the embed.FS and the directory name.
const MigrationsDir = "migrations"

// Web holds the SPA's built bundle at web/dist/.
//
// Why dist/ and not the whole web/ tree:
//   - web/node_modules can be huge (10s of MB) and would bloat the binary
//   - web/src/ is source, not deployable; not needed at runtime
//   - the SPA handler navigates into dist/ anyway
//
// Phase 07 introduces web/dist/. Earlier phases shipped a placeholder
// web/index.html at the web/ root; phase 07 supersedes it with the
// esbuild output. The Dockerfile's frontend stage produces web/dist/.
//
// For "go build" without a prior `npm run build`, this embed pattern
// will fail with "pattern web/dist/*: no matching files found".
// `bootstrap/phase-07-frontend-shell.sh` runs the npm build before
// `go build` to satisfy this; CI and the Dockerfile follow the same
// pattern. Local dev: run `cd web && npm run build` once before
// `go build`.
//
//go:embed all:web/dist
var Web embed.FS

// WebDir is the directory name inside the embedded FS. The SPA handler
// uses this + "/dist" to fs.Sub into the bundle root.
const WebDir = "web"
