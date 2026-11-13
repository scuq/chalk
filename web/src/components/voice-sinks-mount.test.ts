// 135-2: where App mounts the audio of a call. A remount makes new <audio>
// elements during a call, so the mount must not depend on the layout. The
// assertions read the App source, because the test suite has no DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const app = readFileSync(join(resolve(process.cwd(), "src"), "components", "App.tsx"), "utf8");

test("App mounts VoiceSinks one time, as the first child of the shell", () => {
  assert.equal(app.match(/<VoiceSinks\b/g)?.length, 1);
  const sinks = app.indexOf("<VoiceSinks");
  const header = app.indexOf('<header class="chalk-header">');
  assert.ok(sinks > 0 && header > sinks, "VoiceSinks is not before the header");
  const between = app.slice(sinks, header);
  assert.doesNotMatch(between, /isMobile|zucker/, "the mount depends on the layout");
  const open = app.lastIndexOf("<div", sinks);
  assert.match(app.slice(open, sinks), /class=\{`chalk-app /, "VoiceSinks is not a direct child of .chalk-app");
});

test("the sidebar renders on desktop only, and VoiceDock is gone", () => {
  assert.match(app, /\{!isMobile && \(\s*<aside class="chalk-sidebar"/);
  assert.equal(/<VoiceDock\b/.test(app), false);
});
