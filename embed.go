// Package chalk embeds static assets (migrations, web SPA) into the binary.
package chalk

import "embed"

// Migrations holds every .sql file in the migrations/ directory.
//
//go:embed migrations/*.sql
var Migrations embed.FS

// MigrationsDir is the directory name inside the embedded FS.
// migrate.Load needs both the embed.FS and the directory name.
const MigrationsDir = "migrations"

// Web holds the SPA assets served at "/".
//
//go:embed all:web
var Web embed.FS

// WebDir is the directory name inside the embedded FS.
const WebDir = "web"
