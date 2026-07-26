import test from "node:test";
import assert from "node:assert/strict";

import {
  pipWindowSize,
  pipSupported,
  openTilePopout,
  closeTilePopout,
  closeAllTilePopouts,
  popoutKeys,
  subscribePopouts,
  syncTilePopouts,
} from "./pip";

test("pipWindowSize keeps the source aspect ratio when it already fits", () => {
  const { width, height } = pipWindowSize(960, 540);
  assert.equal(width, 960);
  assert.equal(height, 540);
});

test("pipWindowSize scales an oversized source down inside the ceiling", () => {
  const { width, height } = pipWindowSize(3840, 2160);
  assert.ok(width <= 1280 && height <= 800);
  // 16:9 preserved.
  assert.equal(Math.round((width / height) * 100), Math.round((16 / 9) * 100));
});

test("pipWindowSize honours a tall source's ratio, bounded by height", () => {
  const { width, height } = pipWindowSize(1200, 1600);
  assert.equal(height, 800);
  assert.equal(width, 600);
});

test("pipWindowSize falls back to 16:9 for a track with no dimensions yet", () => {
  assert.deepEqual(pipWindowSize(undefined, undefined), { width: 1280, height: 720 });
  assert.deepEqual(pipWindowSize(0, 0), { width: 1280, height: 720 });
});

test("pipSupported is false where the API is absent (node, firefox, safari)", () => {
  assert.equal(pipSupported(), false);
});

// ---- multi-window pop-outs (47-4) ----------------------------------------
//
// Enough of a DOM to exercise the window bookkeeping: what opened, what was
// closed, and which stream each window is showing.

interface FakeEl {
  tag: string;
  textContent: string;
  srcObject: unknown;
  children: FakeEl[];
  autoplay?: boolean;
  playsInline?: boolean;
  muted?: boolean;
  innerHTML: string;
  appendChild(c: FakeEl): void;
}

function el(tag: string): FakeEl {
  return {
    tag,
    textContent: "",
    srcObject: null,
    children: [],
    innerHTML: "",
    appendChild(c: FakeEl) {
      this.children.push(c);
    },
  };
}

interface FakeWin {
  name: string;
  closed: boolean;
  focused: number;
  document: {
    title: string;
    head: FakeEl;
    body: FakeEl;
    createElement(tag: string): FakeEl;
  };
  listeners: Record<string, Array<() => void>>;
  addEventListener(type: string, fn: () => void): void;
  focus(): void;
  close(): void;
  fire(type: string): void;
  video(): FakeEl | undefined;
}

function fakeWin(name: string): FakeWin {
  return {
    name,
    closed: false,
    focused: 0,
    document: { title: "", head: el("head"), body: el("body"), createElement: el },
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    focus() {
      this.focused++;
    },
    close() {
      this.closed = true;
      this.fire("pagehide");
    },
    fire(type) {
      for (const fn of this.listeners[type] ?? []) fn();
    },
    video() {
      return this.document.body.children.find((c) => c.tag === "video");
    },
  };
}

function fakeHost(opts: { blocked?: boolean } = {}) {
  const opened: FakeWin[] = [];
  const host = {
    screen: { availWidth: 1920, availHeight: 1080 },
    listeners: {} as Record<string, Array<() => void>>,
    addEventListener(type: string, fn: () => void) {
      (this.listeners[type] ??= []).push(fn);
    },
    open(_url: string, name: string) {
      if (opts.blocked) return null;
      const w = fakeWin(name);
      opened.push(w);
      return w;
    },
  };
  return { host: host as unknown as Window, opened, raw: host };
}

function fakeStream(id: string) {
  const track = {
    id,
    listeners: [] as Array<() => void>,
    getSettings: () => ({ width: 1280, height: 720 }),
    addEventListener(_t: string, fn: () => void) {
      this.listeners.push(fn);
    },
    removeEventListener(_t: string, fn: () => void) {
      this.listeners = this.listeners.filter((x) => x !== fn);
    },
    end() {
      for (const fn of [...this.listeners]) fn();
    },
  };
  const stream = { id, getVideoTracks: () => [track] };
  return { stream: stream as unknown as MediaStream, track };
}

test("several tiles pop out at once, each into its own window", async () => {
  closeAllTilePopouts();
  const { host, opened } = fakeHost();
  const keys = ["u1:d1", "u2:d1", "u3:d1", "u2:d1:screen"];
  for (const k of keys) {
    assert.equal(await openTilePopout(k, fakeStream(k).stream, k, host), true);
  }
  assert.equal(opened.length, 4);
  assert.deepEqual(popoutKeys().sort(), [...keys].sort());
  // Distinct window names, each showing its own stream.
  assert.equal(new Set(opened.map((w) => w.name)).size, 4);
  assert.equal(opened[0].video()?.muted, true);
  closeAllTilePopouts();
  assert.deepEqual(popoutKeys(), []);
  assert.ok(opened.every((w) => w.closed));
});

test("popping out a tile that is already out raises its window", async () => {
  closeAllTilePopouts();
  const { host, opened } = fakeHost();
  const { stream } = fakeStream("a");
  await openTilePopout("a", stream, "a", host);
  await openTilePopout("a", stream, "a", host);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].focused, 2); // opened, then raised
  closeAllTilePopouts();
});

test("closing one pop-out leaves the others alone", async () => {
  closeAllTilePopouts();
  const { host, opened } = fakeHost();
  await openTilePopout("a", fakeStream("a").stream, "a", host);
  await openTilePopout("b", fakeStream("b").stream, "b", host);
  closeTilePopout("a");
  assert.deepEqual(popoutKeys(), ["b"]);
  assert.equal(opened[0].closed, true);
  assert.equal(opened[1].closed, false);
  closeAllTilePopouts();
});

test("a window closed by the user drops out of the set", async () => {
  closeAllTilePopouts();
  const { host, opened } = fakeHost();
  let notifications = 0;
  const stop = subscribePopouts(() => notifications++);
  await openTilePopout("a", fakeStream("a").stream, "a", host);
  opened[0].closed = true;
  opened[0].fire("pagehide");
  assert.deepEqual(popoutKeys(), []);
  assert.equal(notifications, 2); // open + close
  stop();
});

test("a pop-out closes itself when its stream ends", async () => {
  closeAllTilePopouts();
  const { host, opened } = fakeHost();
  const { stream, track } = fakeStream("a");
  await openTilePopout("a", stream, "a", host);
  track.end();
  assert.deepEqual(popoutKeys(), []);
  assert.equal(opened[0].closed, true);
});

test("sync closes pop-outs whose tile is gone and follows a swapped stream", async () => {
  closeAllTilePopouts();
  const { host, opened } = fakeHost();
  await openTilePopout("a", fakeStream("a").stream, "a", host);
  await openTilePopout("b", fakeStream("b").stream, "b", host);
  const next = fakeStream("a2");
  syncTilePopouts([{ key: "a", stream: next.stream, label: "a — screen" }]);
  assert.deepEqual(popoutKeys(), ["a"]);
  assert.equal(opened[1].closed, true);
  assert.equal(opened[0].video()?.srcObject, next.stream);
  assert.equal(opened[0].document.title, "a — screen");
  // The watcher moved with the stream: the new track's end closes the window.
  next.track.end();
  assert.deepEqual(popoutKeys(), []);
});

test("a blocked pop-up reports failure so the caller can fall back", async () => {
  closeAllTilePopouts();
  const { host } = fakeHost({ blocked: true });
  assert.equal(await openTilePopout("a", fakeStream("a").stream, "a", host), false);
  assert.deepEqual(popoutKeys(), []);
});

test("an audio-only tile has nothing to pop out", async () => {
  closeAllTilePopouts();
  const { host, opened } = fakeHost();
  const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
  assert.equal(await openTilePopout("a", stream, "a", host), false);
  assert.equal(opened.length, 0);
});

test("document PiP takes the first pop-out, plain windows take the rest", async () => {
  closeAllTilePopouts();
  const { host, opened, raw } = fakeHost();
  const pipWin = fakeWin("pip");
  const pip = {
    window: null as FakeWin | null,
    requestWindow: async () => {
      pip.window = pipWin;
      return pipWin as unknown as Window;
    },
  };
  (raw as unknown as { documentPictureInPicture: unknown }).documentPictureInPicture = pip;

  await openTilePopout("a", fakeStream("a").stream, "a", host);
  await openTilePopout("b", fakeStream("b").stream, "b", host);
  assert.equal(opened.length, 1); // only "b" needed a plain window
  assert.equal(pipWin.document.title, "a");
  assert.deepEqual(popoutKeys().sort(), ["a", "b"]);
  closeAllTilePopouts();
});
