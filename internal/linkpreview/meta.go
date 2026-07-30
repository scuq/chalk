package linkpreview

import (
	"html"
	"strings"
)

// pageMeta is what extractMeta pulls from a page: the OpenGraph fields plus
// the classic <title>/meta-description fallbacks.
type pageMeta struct {
	ogTitle  string
	ogDesc   string
	ogImage  string
	ogSite   string
	title    string
	metaDesc string
}

// extractMeta scans HTML for the handful of tags a preview needs. It is a
// deliberate NON-parser: no tree, no scripting, no external dependency --
// just a tag scanner that understands comments, attributes (quoted single or
// double, or unquoted, any case), and entity unescaping. That is enough for
// server-rendered <head> metadata, which is all OpenGraph is. Scanning stops
// at <body>: og tags live in <head>, and stopping keeps a hostile or
// megabyte-long page from costing more than it must. First occurrence of
// each field wins. body may be truncated mid-tag; the scanner just runs out.
func extractMeta(body []byte) pageMeta {
	var m pageMeta
	s := string(body)
	i := 0
	for i < len(s) {
		lt := strings.IndexByte(s[i:], '<')
		if lt < 0 {
			break
		}
		i += lt
		if strings.HasPrefix(s[i:], "<!--") {
			end := strings.Index(s[i:], "-->")
			if end < 0 {
				break
			}
			i += end + 3
			continue
		}
		name, rest := tagName(s[i+1:])
		switch name {
		case "body":
			return m
		case "meta":
			attrs, next := parseAttrs(rest)
			i = len(s) - len(next)
			key := attrs["property"]
			if key == "" {
				key = attrs["name"]
			}
			content := html.UnescapeString(attrs["content"])
			switch strings.ToLower(key) {
			case "og:title":
				setIfEmpty(&m.ogTitle, content)
			case "og:description":
				setIfEmpty(&m.ogDesc, content)
			case "og:image", "og:image:url", "og:image:secure_url":
				setIfEmpty(&m.ogImage, content)
			case "og:site_name":
				setIfEmpty(&m.ogSite, content)
			case "description":
				setIfEmpty(&m.metaDesc, content)
			}
		case "title":
			_, next := parseAttrs(rest)
			i = len(s) - len(next)
			end := indexCaseInsensitive(s[i:], "</title")
			if end < 0 {
				return m
			}
			setIfEmpty(&m.title, html.UnescapeString(strings.TrimSpace(s[i:i+end])))
			i += end
		default:
			i++
		}
	}
	return m
}

// tagName reads the element name at the start of s (just past '<') and
// returns it lower-cased plus the remainder.
func tagName(s string) (string, string) {
	i := 0
	for i < len(s) && (isAlpha(s[i]) || s[i] == '/' && i == 0) {
		i++
	}
	return strings.ToLower(s[:i]), s[i:]
}

// parseAttrs reads attributes up to and including the closing '>'. Names are
// lower-cased; values keep their raw (still-escaped) form -- callers
// unescape. Returns the attribute map and the remainder after '>'.
func parseAttrs(s string) (map[string]string, string) {
	attrs := map[string]string{}
	i := 0
	for i < len(s) {
		for i < len(s) && (isSpace(s[i]) || s[i] == '/') {
			i++
		}
		if i >= len(s) {
			return attrs, ""
		}
		if s[i] == '>' {
			return attrs, s[i+1:]
		}
		start := i
		for i < len(s) && s[i] != '=' && s[i] != '>' && !isSpace(s[i]) {
			i++
		}
		name := strings.ToLower(s[start:i])
		for i < len(s) && isSpace(s[i]) {
			i++
		}
		if i >= len(s) || s[i] != '=' {
			if name != "" {
				attrs[name] = ""
			}
			continue
		}
		i++ // past '='
		for i < len(s) && isSpace(s[i]) {
			i++
		}
		if i >= len(s) {
			return attrs, ""
		}
		var val string
		if q := s[i]; q == '"' || q == '\'' {
			i++
			end := strings.IndexByte(s[i:], q)
			if end < 0 {
				return attrs, ""
			}
			val = s[i : i+end]
			i += end + 1
		} else {
			start := i
			for i < len(s) && !isSpace(s[i]) && s[i] != '>' {
				i++
			}
			val = s[start:i]
		}
		if name != "" {
			attrs[name] = val
		}
	}
	return attrs, ""
}

func setIfEmpty(dst *string, v string) {
	if *dst == "" && strings.TrimSpace(v) != "" {
		*dst = strings.TrimSpace(v)
	}
}

func indexCaseInsensitive(s, sub string) int {
	return strings.Index(strings.ToLower(s), strings.ToLower(sub))
}

func isAlpha(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'
}
