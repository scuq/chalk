import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLink, originOf } from "./links";

const SERVER = "https://chat.example.org";

test("classifyLink: same origin stays in-app", () => {
  assert.equal(classifyLink("https://chat.example.org/join/abc", SERVER), "in-app");
  assert.equal(classifyLink("https://chat.example.org/admin?x=1", SERVER), "in-app");
});

test("classifyLink: other origins and ports go to the system browser", () => {
  assert.equal(classifyLink("https://example.com/", SERVER), "external");
  assert.equal(classifyLink("http://chat.example.org/", SERVER), "external");
  assert.equal(classifyLink("https://chat.example.org:8443/", SERVER), "external");
  assert.equal(classifyLink("mailto:someone@example.org", SERVER), "external");
});

test("classifyLink: about:blank pop-ups are child windows", () => {
  assert.equal(classifyLink("about:blank", SERVER), "child");
  assert.equal(classifyLink("", SERVER), "child");
});

test("classifyLink: everything else is denied", () => {
  assert.equal(classifyLink("file:///etc/passwd", SERVER), "deny");
  assert.equal(classifyLink("javascript:alert(1)", SERVER), "deny");
  assert.equal(classifyLink("chrome://settings", SERVER), "deny");
  assert.equal(classifyLink("not a url", SERVER), "deny");
});

test("classifyLink: with no server (picker showing) nothing is in-app", () => {
  assert.equal(classifyLink("https://chat.example.org/", null), "external");
});

test("originOf", () => {
  assert.equal(originOf("https://chat.example.org:8443/"), "https://chat.example.org:8443");
  assert.equal(originOf(null), null);
  assert.equal(originOf("junk"), null);
});
