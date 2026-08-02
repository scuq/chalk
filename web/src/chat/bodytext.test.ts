import { test } from "node:test";
import assert from "node:assert/strict";
import { messageText, clipboardText } from "./bodytext";
import { encodeGiphyBody } from "../giphy/giphy";
import { encodeLinkPreviewBody } from "../linkpreview/linkpreview";
import { encodeCodeBody } from "../code/code";

const GIF = "https://media2.giphy.com/media/abc123/giphy.gif";
const SNIPPET = "if err != nil {\n\treturn err\n}";
const PREVIEW = {
  url: "https://example.com/a",
  title: "A page",
  description: "about things",
  site_name: "Example",
};

// ---- messageText -------------------------------------------------------

test("messageText passes a plain body through", () => {
  assert.equal(messageText("hello @alice"), "hello @alice");
  assert.equal(messageText(""), "");
});

test("messageText yields only the caption of a code message", () => {
  assert.equal(messageText(encodeCodeBody({ code: SNIPPET, lang: "go" }, "look:")), "look:");
  assert.equal(messageText(encodeCodeBody({ code: SNIPPET, lang: "go" }, "")), "");
});

// The reason this function exists: a handle inside pasted code is not
// somebody being addressed, and must not ping them.
test("messageText hides an @handle buried in a snippet", () => {
  const body = encodeCodeBody({ code: "// ask @alice about this", lang: "go" }, "ptal");
  assert.equal(messageText(body), "ptal");
  assert.ok(!messageText(body).includes("@alice"));
});

test("messageText yields only the caption of a preview message", () => {
  assert.equal(messageText(encodeLinkPreviewBody(PREVIEW, "see this")), "see this");
});

test("messageText yields nothing for a giphy message", () => {
  assert.equal(messageText(encodeGiphyBody(GIF)), "");
});

test("messageText falls back to the raw body when framing is corrupt", () => {
  assert.equal(messageText("\u0001chalk:code:v1\u0001nope"), "\u0001chalk:code:v1\u0001nope");
});

// ---- clipboardText -----------------------------------------------------

test("clipboardText passes a plain body through", () => {
  assert.equal(clipboardText("hello"), "hello");
});

test("clipboardText copies the snippet, not the caption or the framing", () => {
  const body = encodeCodeBody({ code: SNIPPET, lang: "go" }, "here's the fix:");
  assert.equal(clipboardText(body), SNIPPET);
  assert.ok(!clipboardText(body).includes("\u0001"));
});

test("clipboardText copies a giphy's url", () => {
  assert.equal(clipboardText(encodeGiphyBody(GIF)), GIF);
});

test("clipboardText copies a preview's caption, or its url when there is none", () => {
  assert.equal(clipboardText(encodeLinkPreviewBody(PREVIEW, "see this")), "see this");
  assert.equal(clipboardText(encodeLinkPreviewBody(PREVIEW, "")), PREVIEW.url);
});
