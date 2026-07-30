import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  fetchLinkPreview,
  fetchLinkPreviewThumb,
  linkPreviewThumbFilename,
  LINKPREVIEW_THUMB_PREFIX,
} from "./fetch";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(handler(String(input)))) as typeof fetch;
}

test("fetchLinkPreview returns sanitized payload + imageURL", async () => {
  stubFetch((url) => {
    assert.ok(url.startsWith("/api/linkpreview?url="));
    return new Response(
      JSON.stringify({
        url: "https://www.youtube.com/watch?v=abc", // final url; ignored for the card
        title: "A Video",
        description: "About things",
        site_name: "YouTube",
        image_url: "https://i.ytimg.com/vi/abc/hq720.jpg",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const fp = await fetchLinkPreview("https://youtu.be/abc");
  assert.ok(fp);
  assert.equal(fp.payload.url, "https://youtu.be/abc"); // the url the user typed
  assert.equal(fp.payload.title, "A Video");
  assert.equal(fp.imageURL, "https://i.ytimg.com/vi/abc/hq720.jpg");
});

test("fetchLinkPreview: image-only page gets a host-stub title", async () => {
  stubFetch(() =>
    new Response(JSON.stringify({ image_url: "https://cdn.example.com/x.jpg" }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  const fp = await fetchLinkPreview("https://youtu.be/abc");
  assert.ok(fp);
  assert.equal(fp.payload.title, "youtu.be");
  assert.equal(fp.imageURL, "https://cdn.example.com/x.jpg");
});

test("fetchLinkPreview returns null on error status, garbage json, empty page", async () => {
  stubFetch(() => new Response("nope", { status: 502 }));
  assert.equal(await fetchLinkPreview("https://youtu.be/abc"), null);

  stubFetch(() => new Response("not json"));
  assert.equal(await fetchLinkPreview("https://youtu.be/abc"), null);

  stubFetch(() => new Response(JSON.stringify({ url: "https://x.com" })));
  assert.equal(await fetchLinkPreview("https://youtu.be/abc"), null);

  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
  assert.equal(await fetchLinkPreview("https://youtu.be/abc"), null);
});

test("fetchLinkPreviewThumb enforces image content type", async () => {
  stubFetch(() => new Response(new Blob(["PNG"], { type: "image/png" })));
  const blob = await fetchLinkPreviewThumb("https://i.ytimg.com/x.png");
  assert.ok(blob);
  assert.equal(blob.type, "image/png");

  stubFetch(() => new Response(new Blob(["<html>"], { type: "text/html" })));
  assert.equal(await fetchLinkPreviewThumb("https://i.ytimg.com/x.png"), null);

  stubFetch(() => new Response("x", { status: 429 }));
  assert.equal(await fetchLinkPreviewThumb("https://i.ytimg.com/x.png"), null);
});

test("linkPreviewThumbFilename maps mimes and keeps the convention prefix", () => {
  assert.equal(linkPreviewThumbFilename("image/jpeg"), "linkpreview.jpg");
  assert.equal(linkPreviewThumbFilename("image/webp"), "linkpreview.webp");
  assert.equal(linkPreviewThumbFilename("image/tiff"), "linkpreview.img");
  assert.ok(linkPreviewThumbFilename("image/png").startsWith(LINKPREVIEW_THUMB_PREFIX));
});
