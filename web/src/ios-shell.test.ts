import { test } from "node:test";
import assert from "node:assert/strict";
import { IOS_PHONE_CALL_EVENT, installIOSPhoneCallListener, iosShellPresent } from "./ios-shell";

test("the iOS shell mark is read structurally", () => {
  assert.equal(iosShellPresent({ chalkIOS: { shell: "chalk-ios/1" } }), true);
  assert.equal(iosShellPresent({ chalkIOS: { shell: "chalk-desktop/1.2" } }), false);
  assert.equal(iosShellPresent({ chalkIOS: { shell: 1 } }), false);
  assert.equal(iosShellPresent({ chalkIOS: {} }), false);
  assert.equal(iosShellPresent({ chalkDesktop: { shell: "chalk-ios/1" } }), false);
  assert.equal(iosShellPresent({}), false);
  assert.equal(iosShellPresent(undefined), false);
  assert.equal(iosShellPresent(null), false);
});

test("the phone-call listener exists only inside the iOS shell", () => {
  const listeners = new Map<string, () => void>();
  const fake = {
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const g = globalThis as { window?: unknown };
  const before = g.window;
  try {
    g.window = fake;
    let calls = 0;
    installIOSPhoneCallListener(() => calls++)();
    assert.equal(listeners.size, 0, "outside the shell nothing listens");

    g.window = { ...fake, chalkIOS: { shell: "chalk-ios/1" } };
    const remove = installIOSPhoneCallListener(() => calls++);
    assert.equal(listeners.size, 1);
    listeners.get(IOS_PHONE_CALL_EVENT)?.();
    assert.equal(calls, 1);
    remove();
    assert.equal(listeners.size, 0);
  } finally {
    g.window = before;
  }
});
