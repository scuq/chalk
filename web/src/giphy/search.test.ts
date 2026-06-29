import { test } from "node:test";
import assert from "node:assert/strict";
import { searchGiphy } from "./search";

// Helper: install a fake global.fetch for one test, restore after.
function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = orig;
  });
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const SAMPLE = {
  id: "abc",
  title: "cat",
  preview_url: "https://media2.giphy.com/abc/fwd.gif",
  preview_width: 200,
  preview_height: 150,
  full_url: "https://media2.giphy.com/abc/fw.gif",
  full_width: 480,
  full_height: 360,
};

test("searchGiphy hits the proxy with an encoded query and maps results", async () => {
  let calledURL = "";
  await withFetch(
    async (url) => {
      calledURL = url;
      return jsonResponse({ results: [SAMPLE] });
    },
    async () => {
      const out = await searchGiphy("happy cat");
      assert.equal(calledURL, "/api/giphy/search?q=happy%20cat");
      assert.equal(out.length, 1);
      assert.deepEqual(out[0], SAMPLE);
    },
  );
});

test("searchGiphy returns [] for a blank query without fetching", async () => {
  let called = false;
  await withFetch(
    async () => {
      called = true;
      return jsonResponse({ results: [] });
    },
    async () => {
      assert.deepEqual(await searchGiphy("   "), []);
      assert.equal(called, false);
    },
  );
});

test("searchGiphy throws on a non-OK response", async () => {
  await withFetch(
    async () => jsonResponse({}, false, 502),
    async () => {
      await assert.rejects(() => searchGiphy("cats"), /502/);
    },
  );
});

test("searchGiphy tolerates a missing/!array results field", async () => {
  await withFetch(
    async () => jsonResponse({}),
    async () => {
      assert.deepEqual(await searchGiphy("cats"), []);
    },
  );
});

test("searchGiphy encodes special characters in the query", async () => {
  let calledURL = "";
  await withFetch(
    async (url) => {
      calledURL = url;
      return jsonResponse({ results: [] });
    },
    async () => {
      await searchGiphy("a&b=c?d");
      assert.equal(calledURL, "/api/giphy/search?q=a%26b%3Dc%3Fd");
    },
  );
});
