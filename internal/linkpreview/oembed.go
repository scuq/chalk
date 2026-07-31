// YouTube oEmbed fast-path. YouTube's bot mitigation intermittently serves
// the fetcher an og-less shell page (empty " - YouTube" title, geo-localized
// generic description), which the <title>/meta-description fallback turned
// into a wrong-but-plausible card. The public oEmbed endpoint returns the
// real title, channel, and thumbnail as ~1 KB of JSON and 404s on unknown
// ids, so video URLs skip HTML fetching entirely.
package linkpreview

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
)

const youtubeOEmbedBase = "https://www.youtube.com/oembed"

// oembedResponse is the subset of the oEmbed JSON we consume.
type oembedResponse struct {
	Title        string `json:"title"`
	AuthorName   string `json:"author_name"`
	ProviderName string `json:"provider_name"`
	ThumbnailURL string `json:"thumbnail_url"`
}

// isYouTubeVideoURL reports whether u clearly identifies a single YouTube
// video. Only those go through oEmbed; channels, playlists, and the homepage
// keep the HTML OG path (oEmbed 404s on them, and OG works fine there).
func isYouTubeVideoURL(u *url.URL) bool {
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")
	switch host {
	case "youtu.be":
		return len(segs) == 1 && segs[0] != ""
	case "youtube.com", "www.youtube.com", "m.youtube.com":
		if len(segs) == 1 && segs[0] == "watch" {
			return u.Query().Get("v") != ""
		}
		if len(segs) == 2 && (segs[0] == "shorts" || segs[0] == "live") {
			return segs[1] != ""
		}
	}
	return false
}

// fetchYouTubeOEmbed builds a Preview from YouTube's public oEmbed endpoint.
// No HTML fallback on failure: the HTML path is exactly the wrong-card path,
// so an error here means no card.
func (c *Client) fetchYouTubeOEmbed(ctx context.Context, videoURL *url.URL) (*Preview, error) {
	endpoint := c.oembedBase + "?format=json&url=" + url.QueryEscape(videoURL.String())
	resp, err := c.get(ctx, endpoint, "application/json")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(ct), "application/json") {
		return nil, fmt.Errorf("linkpreview: oembed response is not json (%s)", ct)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxOEmbedBytes))
	if err != nil {
		return nil, fmt.Errorf("linkpreview: read oembed body: %w", err)
	}
	var o oembedResponse
	if err := json.Unmarshal(body, &o); err != nil {
		return nil, fmt.Errorf("linkpreview: parse oembed body: %w", err)
	}
	return &Preview{
		URL:   videoURL.String(),
		Title: capRunes(strings.TrimSpace(o.Title), maxTitleRunes),
		// oEmbed has no description; the channel name reads well in its slot.
		Description: capRunes(strings.TrimSpace(o.AuthorName), maxDescRunes),
		SiteName:    capRunes(firstNonEmpty(o.ProviderName, "YouTube"), maxSiteRunes),
		ImageURL:    resolveImageURL(videoURL, o.ThumbnailURL),
	}, nil
}
