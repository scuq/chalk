package server

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spaHandler serves the SPA from an embedded filesystem rooted at the
// dist/ subdirectory of webFS. The dist/ subtree is what esbuild emits
// (index.html, index.js, theme.css plus any chunk files); we serve it
// at the URL root.
//
// Behavior:
//   - GET /                       -> dist/index.html
//   - GET /<path> (no extension)  -> dist/index.html  (SPA fallback so
//     the client router owns deep links).
//     This applies whether or not the
//     path resolves to anything in the
//     embedded FS -- the SPA owns the
//     URL namespace for extensionless
//     routes.
//   - GET /<path>.<ext>           -> dist/<path>.<ext> if it exists,
//     404 otherwise (real not-found so
//     missing assets are visible to
//     devs and to the browser's network
//     panel)
//
// Caching: index.html is no-cache (always revalidate so users see new
// bundles on next load). Other assets get a short max-age (5 min)
// since the bundle filenames don't yet carry content hashes. Phase 13
// can switch to hashed filenames + immutable caching.
//
// Dotfiles and ".." traversal are refused as a defense-in-depth
// measure; the dist/ tree shouldn't have any.
func spaHandler(webFS fs.FS, distDir string) (http.Handler, error) {
	dist, err := fs.Sub(webFS, distDir)
	if err != nil {
		return nil, err
	}
	// Verify index.html exists at startup so a misconfigured embed
	// fails loudly rather than silently 404'ing every request.
	if _, err := fs.Stat(dist, "index.html"); err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveSPA(w, r, dist)
	}), nil
}

func serveSPA(w http.ResponseWriter, r *http.Request, dist fs.FS) {
	upath := strings.TrimPrefix(r.URL.Path, "/")
	if upath == "" {
		serveIndex(w, r, dist)
		return
	}
	// Reject path traversal and any dotfile segments before anything
	// else -- these always return 404 regardless of routing.
	clean := path.Clean(upath)
	if clean == "." || strings.HasPrefix(clean, "../") {
		http.NotFound(w, r)
		return
	}
	for _, seg := range strings.Split(clean, "/") {
		if strings.HasPrefix(seg, ".") {
			http.NotFound(w, r)
			return
		}
	}

	// Extensionless paths belong to the SPA client router. Serve
	// index.html unconditionally; the client decides what to render
	// for /channels/general, /settings, /icons, whatever. Doing this
	// BEFORE the fs.Open avoids two pitfalls:
	//   1. If the path happens to resolve to a directory inside dist/
	//      (e.g. dist/icons), Open returns a successful directory
	//      handle and we'd 404 on the IsDir() check below, hiding the
	//      SPA route from the client.
	//   2. If the path resolves to nothing, we'd 404 instead of
	//      letting the SPA route handle it.
	if path.Ext(clean) == "" {
		serveIndex(w, r, dist)
		return
	}

	f, err := dist.Open(clean)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		http.Error(w, "stat: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if info.IsDir() {
		// Has an extension and resolves to a directory? Bizarre but
		// we treat as 404 -- directory listings would leak the bundle
		// layout and the client never asks for one with a real .ext.
		http.NotFound(w, r)
		return
	}

	// embed.FS files implement io.ReadSeeker; http.ServeContent handles
	// content-type sniffing, ETag, range requests, conditional GETs.
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		http.Error(w, "internal: file not seekable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	http.ServeContent(w, r, clean, info.ModTime(), rs)
}

func serveIndex(w http.ResponseWriter, r *http.Request, dist fs.FS) {
	f, err := dist.Open("index.html")
	if err != nil {
		http.Error(w, "index.html missing", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		http.Error(w, "internal: index.html not seekable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", info.ModTime(), rs)
}
