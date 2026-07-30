package linkpreview

import "testing"

func TestExtractMetaOpenGraph(t *testing.T) {
	body := `<!DOCTYPE html><html><head>
		<META PROPERTY="og:title" CONTENT="Half-Life 3">
		<meta property='og:description' content='It is real &amp; it is here'>
		<meta property="og:image" content="https://cdn.example.com/hl3.jpg">
		<meta property="og:site_name" content=Steam>
		<title>fallback title</title>
	</head><body><meta property="og:title" content="too late"></body></html>`

	m := extractMeta([]byte(body))
	if m.ogTitle != "Half-Life 3" {
		t.Fatalf("ogTitle = %q", m.ogTitle)
	}
	if m.ogDesc != "It is real & it is here" {
		t.Fatalf("ogDesc = %q (entity not unescaped?)", m.ogDesc)
	}
	if m.ogImage != "https://cdn.example.com/hl3.jpg" {
		t.Fatalf("ogImage = %q", m.ogImage)
	}
	if m.ogSite != "Steam" {
		t.Fatalf("ogSite = %q (unquoted attr)", m.ogSite)
	}
	if m.title != "fallback title" {
		t.Fatalf("title = %q", m.title)
	}
}

func TestExtractMetaFallbacks(t *testing.T) {
	body := `<html><head>
		<title> Page &quot;Title&quot; </title>
		<meta name="description" content="plain description">
	</head><body></body></html>`
	m := extractMeta([]byte(body))
	if m.title != `Page "Title"` {
		t.Fatalf("title = %q", m.title)
	}
	if m.metaDesc != "plain description" {
		t.Fatalf("metaDesc = %q", m.metaDesc)
	}
	if m.ogTitle != "" {
		t.Fatalf("ogTitle should be empty, got %q", m.ogTitle)
	}
}

func TestExtractMetaFirstWinsAndNameVariant(t *testing.T) {
	body := `<head>
		<meta name="og:title" content="via name attr">
		<meta property="og:title" content="second occurrence">
		<meta property="og:image:secure_url" content="https://img.example.com/a.png">
	</head>`
	m := extractMeta([]byte(body))
	if m.ogTitle != "via name attr" {
		t.Fatalf("ogTitle = %q (first occurrence must win)", m.ogTitle)
	}
	if m.ogImage != "https://img.example.com/a.png" {
		t.Fatalf("ogImage = %q", m.ogImage)
	}
}

func TestExtractMetaIgnoresCommentsAndStopsAtBody(t *testing.T) {
	body := `<head>
		<!-- <meta property="og:title" content="commented out"> -->
		<meta property="og:title" content="real">
	</head><body><meta property="og:description" content="in body, ignored"></body>`
	m := extractMeta([]byte(body))
	if m.ogTitle != "real" {
		t.Fatalf("ogTitle = %q", m.ogTitle)
	}
	if m.ogDesc != "" {
		t.Fatalf("ogDesc = %q (scanner must stop at <body>)", m.ogDesc)
	}
}

func TestExtractMetaHostileInput(t *testing.T) {
	// Truncated mid-tag, unterminated comment, unterminated quote, empty --
	// must terminate without panicking and yield nothing or partial data.
	for _, body := range []string{
		"",
		"<",
		"<!-- never closed",
		`<meta property="og:title content="x">`,
		`<meta property="og:title" content="cut off`,
		`<title>never closed`,
		"<><><meta><title></title>",
	} {
		_ = extractMeta([]byte(body))
	}
}
