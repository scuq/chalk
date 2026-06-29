// att-4c: client for the server-proxied Giphy search (att-4a's
// GET /api/giphy/search). The API key lives server-side; the SPA only ever
// sees the trimmed result list, and the session cookie authenticates the
// request. This is a SEARCH call to our own server -- not a Giphy CDN fetch --
// so it carries no per-viewer privacy concern (that's the render path, gated
// by decideGiphyRender).

// GiphyResult mirrors the server's trimmed giphy.Result shape. All URLs point
// at Giphy's CDN and are re-validated by isAllowedGiphyURL before any render.
export interface GiphyResult {
  id: string;
  title: string;
  preview_url: string;
  preview_width: number;
  preview_height: number;
  full_url: string;
  full_width: number;
  full_height: number;
}

interface SearchResponse {
  results: GiphyResult[];
}

// searchGiphy queries the server proxy. Returns [] for a blank query without
// touching the network. Throws on network failure or a non-OK response so the
// caller can show an inline error. An AbortSignal lets the picker cancel a
// stale in-flight search when the query changes.
export async function searchGiphy(query: string, signal?: AbortSignal): Promise<GiphyResult[]> {
  const q = query.trim();
  if (q === "") return [];
  const resp = await fetch(`/api/giphy/search?q=${encodeURIComponent(q)}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!resp.ok) {
    throw new Error(`giphy search failed: ${resp.status}`);
  }
  const body = (await resp.json()) as SearchResponse;
  return Array.isArray(body.results) ? body.results : [];
}
