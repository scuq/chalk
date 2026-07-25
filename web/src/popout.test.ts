import { test } from "node:test";
import assert from "node:assert/strict";
import { isPopoutWindow, openPopout, POPOUT_NAME } from "./popout";

function fakeWindow(over: Partial<Window> = {}): Window {
  return {
    name: "",
    opener: null,
    screen: { availWidth: 1920, availHeight: 1080 },
    location: { href: "https://chalk.example/channels/general" },
    open: () => null,
    ...over,
  } as unknown as Window;
}

test("a plain tab is not the pop-out", () => {
  assert.equal(isPopoutWindow(fakeWindow()), false);
});

test("the pop-out is recognised by its window name", () => {
  assert.equal(isPopoutWindow(fakeWindow({ name: POPOUT_NAME })), true);
});

// The case window.opener misses: the opening tab was closed, or the window
// was restored from a previous session, so opener is gone but the window is
// still the pop-out.
test("the pop-out is still recognised once its opener is gone", () => {
  assert.equal(isPopoutWindow(fakeWindow({ name: POPOUT_NAME, opener: null })), true);
});

test("a child window is recognised by its opener before the name lands", () => {
  assert.equal(isPopoutWindow(fakeWindow({ opener: {} as Window })), true);
});

test("undefined window (SSR / no DOM) is not the pop-out", () => {
  assert.equal(isPopoutWindow(undefined), false);
});

test("openPopout targets the shared name and centres the window", () => {
  const calls: Array<[string, string, string]> = [];
  let focused = 0;
  const w = fakeWindow({
    open: ((url: string, target: string, features: string) => {
      calls.push([url, target, features]);
      return { focus: () => focused++ } as unknown as Window;
    }) as Window["open"],
  });

  openPopout(w);

  assert.equal(calls.length, 1);
  const [url, target, features] = calls[0];
  assert.equal(url, "https://chalk.example/channels/general");
  assert.equal(target, POPOUT_NAME);
  assert.match(features, /width=1200/);
  assert.match(features, /height=860/);
  assert.match(features, /left=360/);
  assert.match(features, /top=110/);
  assert.equal(focused, 1);
});

test("openPopout clamps to a screen smaller than the target size", () => {
  const calls: string[] = [];
  const w = fakeWindow({
    screen: { availWidth: 1024, availHeight: 600 } as Screen,
    open: ((_url: string, _target: string, features: string) => {
      calls.push(features);
      return null;
    }) as Window["open"],
  });

  openPopout(w);

  assert.match(calls[0], /width=1024/);
  assert.match(calls[0], /height=600/);
  assert.match(calls[0], /left=0/);
  assert.match(calls[0], /top=0/);
});

// A blocked pop-up returns null; the caller must not throw on .focus().
test("openPopout survives a blocked pop-up", () => {
  const w = fakeWindow({ open: (() => null) as Window["open"] });
  assert.doesNotThrow(() => openPopout(w));
});
