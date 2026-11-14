// 135-5: the phone call bar and call view. These assertions read theme.css
// and the component sources as text, because the test suite has no DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const src = join(resolve(process.cwd()), "src");
const css = readFileSync(join(src, "theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const app = readFileSync(join(src, "components", "App.tsx"), "utf8");
const controls = readFileSync(join(src, "components", "VoiceControls.tsx"), "utf8");

function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[};])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no parsable "${selector} { ... }" rule`);
  return m[1];
}

test("the call bar is at least 52px, and its buttons are 44px", () => {
  assert.match(block(".chalk-pcall-bar"), /min-height:\s*52px;/);
  const btn = block(".chalk-pcall-btn");
  assert.match(btn, /width:\s*44px;/);
  assert.match(btn, /height:\s*44px;/);
});

test("the call view covers the screen above the header and below dialogs", () => {
  const view = block(".chalk-pcall");
  assert.match(view, /position:\s*fixed;/);
  assert.match(view, /inset:\s*0;/);
  assert.match(view, /z-index:\s*60;/);
});

test("the controls are 64px, muted is amber, and leave is red", () => {
  assert.match(block(".chalk-pcall-ctl"), /height:\s*64px;/);
  assert.match(block(".chalk-pcall-ctl--off"), /color:\s*var\(--chalk-warn\)/);
  assert.match(block(".chalk-pcall-ctl--leave"), /color:\s*var\(--chalk-error\)/);
});

test("nothing in the call view or the row sheet moves under reduced motion", () => {
  const m = /@media \(prefers-reduced-motion: reduce\) \{\s*\.chalk-pcall,\s*\.chalk-prow-sheet,\s*\.chalk-pcall--speaking,\s*\.chalk-pcall-level i \{\s*animation:\s*none !important;/.exec(css);
  assert.ok(m, "no reduced-motion rule for the call view");
});

test("the old phone call surfaces are gone, and the room page is desktop only", () => {
  assert.equal(existsSync(join(src, "components", "ZuckerCallBar.tsx")), false);
  assert.equal(/export function VoiceControls\b/.test(controls), false);
  for (const gone of [".chalk-voice-controls", ".chalk-voice-ctlbtn", ".chalk-zucker-callbar", ".chalk-voice-dock", ".chalk-footer-left"]) {
    assert.equal(css.includes(gone), false, `${gone} is still in theme.css`);
  }
  assert.match(app, /ccReady && !isMobile && \(\s*<VoiceCallPanel/);
  assert.match(app, /<PhoneCallBar\b/);
  assert.match(app, /<PhoneCallSheet\b/);
});
