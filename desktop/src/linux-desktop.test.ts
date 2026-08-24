import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopEntry } from "./linux-desktop";

test("desktopEntry quotes the executable path", () => {
  const e = desktopEntry('/opt/my apps/chalk "x"/chalk');
  assert.match(e, /^Exec="\/opt\/my apps\/chalk \\"x\\"\/chalk" %U$/m);
  assert.match(e, /^Icon=chalk$/m);
  assert.match(e, /^StartupWMClass=chalk$/m);
  assert.ok(e.endsWith("\n"));
});
