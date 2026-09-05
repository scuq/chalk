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
// (index.html plus content-hashed entry bundles index-XXXX.js /
// theme-XXXX.css and code-split chunks/*); we serve it at the URL root.
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
// bundles on next load). Every other asset esbuild emits into dist/ now
// carries a content hash in its filename (entry bundles index-XXXX.js /
// theme-XXXX.css and code-split chunks/*-XXXX.js), so those are served
// immutable with a one-year max-age -- a changed bundle gets a new URL,
// and unchanged assets stay cached across deploys. This is what removes
// the hard-refresh requirement: index.html (no-cache) is always re-read,
// it references the new hashed asset URLs, and the browser fetches only
// what actually changed.
//
// Dotfiles and ".." traversal are refused as a defense-in-depth
// measure; the dist/ tree shouldn't have any.
//
// Security headers: see contentSecurityPolicy below. They are set here
// rather than in the Caddy templates so that every way of running chalkd
// -- behind chalkctl's Caddy, behind someone else's proxy, or directly --
// gets the same policy, and so the policy travels with the bundle it was
// written for.
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

// giphyImgSources mirrors GIPHY_ALLOWED_HOSTS in web/src/giphy/giphy.ts.
const giphyImgSources = "https://media.giphy.com https://media0.giphy.com " +
	"https://media1.giphy.com https://media2.giphy.com https://media3.giphy.com " +
	"https://media4.giphy.com https://i.giphy.com"

// contentSecurityPolicy is the policy chalk serves on its own documents.
//
// The directive carrying the weight is connect-src. chalk is a blind relay:
// everything valuable is decrypted in this origin, and the identity private
// key lives in its IndexedDB. Pinning every outbound connection to our own
// origin is what stops a compromised bundled dependency from being able to
// talk to anyone but us -- the WebSocket included, since CSP 'self' covers
// the ws/wss upgrade of the page's own origin and App builds its URL from
// window.location.
//
// Three allowances are load-bearing rather than lax:
//
//   - 'wasm-unsafe-eval': Argon2id runs in WebAssembly (hash-wasm) on every
//     login. Without it nobody can derive a key, i.e. nobody can log in.
//   - data: in img-src: the TOTP enrollment QR is a data: GIF produced by
//     qrcode-generator. blob: in img-src/media-src is every decrypted
//     attachment -- they are decrypted client-side and handed to <img> and
//     <video> as blob URLs, so they are never fetched as themselves.
//   - the Giphy CDN hosts in img-src: a rendered GIF is fetched by the
//     viewer's own browser straight from Giphy (that IS the feature, and the
//     leak it implies is what the per-viewer opt-in exists to gate). The
//     search API is proxied through us and needs nothing here.
//
// The Giphy list must stay in step with GIPHY_ALLOWED_HOSTS in
// web/src/giphy/giphy.ts -- that check is the primary gate and this is the
// browser-level second lock behind it. The policy cannot be narrowed to
// viewers who opted in: the document is served before we know who is asking.
//
// style-src is strict, which costs two small accommodations elsewhere: the
// noscript notice styles from theme.css instead of a style attribute, and
// the pop-out windows style their elements through the CSSOM (which CSP
// does not gate) instead of injecting a <style>.
var contentSecurityPolicy = strings.Join([]string{
	"default-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"style-src 'self'",
	"img-src 'self' data: blob: " + giphyImgSources,
	"media-src 'self' blob:",
	"font-src 'self'",
	"connect-src 'self'",
	"manifest-src 'self'",
	"worker-src 'self'",
	"object-src 'none'",
	"frame-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
}, "; ")

// setDocumentHeaders applies the policy that only makes sense on a document
// response. Referrer-Policy matters more than it looks: chalk puts one-shot
// secrets in the query string (?admin_token=, invite links), and message
// bodies render user-supplied http(s) links, so a Referer header is a way
// for a URL that was meant for one person to reach a stranger's access log.
func setDocumentHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
}

func serveSPA(w http.ResponseWriter, r *http.Request, dist fs.FS) {
	// Before any branch, including the 404s: an asset the browser is allowed
	// to re-type by sniffing is an asset that can be something other than
	// what dist/ says it is.
	w.Header().Set("X-Content-Type-Options", "nosniff")

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
	// All non-index assets are content-hashed (see build.mjs / spaHandler
	// doc), so a filename uniquely identifies its bytes: cache immutably for
	// a year. A new bundle changes the hash and thus the URL, so there's no
	// stale-cache risk and no revalidation traffic for unchanged assets.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if ct := contentTypeFor(clean); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeContent(w, r, clean, info.ModTime(), rs)
}

// contentTypeFor names the types http.ServeContent would otherwise have to
// guess at, returning "" for everything it already knows.
//
// This is not a nicety for .wasm (52-2). ServeContent falls back to sniffing
// the first bytes, we send X-Content-Type-Options: nosniff, and
// WebAssembly.instantiateStreaming REFUSES anything that is not
// application/wasm -- so without this the background-blur runtime fails to
// start, on a MIME technicality, with an error that points nowhere near here.
//
// Go's own table has no entry for either extension, and mime.AddExtensionType
// would reach into process-global state that a test or an embedding program
// could see; a local map is the smaller thing to reason about.
func contentTypeFor(name string) string {
	switch path.Ext(name) {
	case ".wasm":
		return "application/wasm"
	case ".tflite":
		// No registered type exists. Being explicit stops the sniffer from
		// deciding a model file is text and stops nosniff from blocking it.
		return "application/octet-stream"
	case ".mp3":
		// 102-4: the arcade theme's cues. Go's own table has no .mp3, and
		// ServeContent's sniffer only recognises one because upstream's
		// files happen to carry an ID3 tag -- a re-export without one
		// would silently become application/octet-stream. Nothing breaks
		// today either way (the player fetches bytes and hands them to
		// decodeAudioData, which ignores the type), but a correct header
		// costs one line and a wrong one is confusing in a network log.
		return "audio/mpeg"
	default:
		return ""
	}
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
	setDocumentHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", info.ModTime(), rs)
}
