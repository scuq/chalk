import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLink, originOf, parseWindowFeatures } from "./links";

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

// 104-6: the pop-up geometry a page asks for.

test("parseWindowFeatures: the pop-out call window's own string", () => {
  assert.deepEqual(parseWindowFeatures("popup=yes,width=960,height=540,left=180,top=140"), {
    width: 960,
    height: 540,
    x: 180,
    y: 140,
  });
});

test("parseWindowFeatures: the recovery print window and a bare pop-up", () => {
  assert.deepEqual(parseWindowFeatures("width=480,height=640"), { width: 480, height: 640 });
  assert.deepEqual(parseWindowFeatures(""), {});
  assert.deepEqual(parseWindowFeatures(undefined), {});
  assert.deepEqual(parseWindowFeatures("popup=yes,noopener"), {});
});

test("parseWindowFeatures: tolerant of spacing and case, strict about values", () => {
  assert.deepEqual(parseWindowFeatures(" Width = 300 , HEIGHT=200 "), { width: 300, height: 200 });
  assert.deepEqual(parseWindowFeatures("width=abc,height=1.5,left=-4,top=9999999"), {});
  assert.deepEqual(parseWindowFeatures("width=10,height=99999"), {});
  assert.deepEqual(parseWindowFeatures("width=100,height=8192,left=0,top=0"), {
    width: 100,
    height: 8192,
    x: 0,
    y: 0,
  });
});
