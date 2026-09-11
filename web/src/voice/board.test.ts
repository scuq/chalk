import test from "node:test";
import assert from "node:assert/strict";
import {
  boardLayout,
  boardOpen,
  boardWindowSize,
  closeBoard,
  openBoard,
  subscribeBoard,
  syncBoard,
} from "./board";

test("boardLayout: nothing for nothing, one tile fills, four make a 2x2", () => {
  assert.deepEqual(boardLayout(0, 800, 600), []);
  const one = boardLayout(1, 800, 600);
  assert.equal(one.length, 1);
  assert.ok(one[0].width > 700 && one[0].left >= 0 && one[0].top >= 0);
  const four = boardLayout(4, 800, 600);
  assert.equal(four.length, 4);
  // Two columns: tiles 0 and 1 share a row, 0 and 2 share a column.
  assert.equal(four[0].top, four[1].top);
  assert.equal(four[0].left, four[2].left);
  assert.ok(four[1].left > four[0].left);
  assert.ok(four[2].top > four[0].top);
  // Every tile is 16:9 plus its strip, and inside the board.
  for (const r of four) {
    assert.ok(Math.abs((r.height - 22) / r.width - 9 / 16) < 0.02);
    assert.ok(r.left + r.width <= 800 && r.top + r.height <= 600);
  }
});

test("boardLayout: three tiles take a 2x2 grid with a gap, five a 3x2", () => {
  assert.equal(new Set(boardLayout(3, 800, 600).map((r) => r.top)).size, 2);
  assert.equal(new Set(boardLayout(5, 1200, 600).map((r) => r.left)).size, 3);
});

test("boardWindowSize is most of the screen, capped and floored", () => {
  assert.deepEqual(boardWindowSize(1920, 1080), { width: 1280, height: 800 });
  assert.deepEqual(boardWindowSize(1000, 700), { width: 800, height: 560 });
  assert.deepEqual(boardWindowSize(400, 300), { width: 480, height: 320 });
});

// ---- the window ------------------------------------------------------------

interface FakeEl {
  tag: string;
  textContent: string;
  srcObject: unknown;
  children: FakeEl[];
  parent: FakeEl | null;
  muted?: boolean;
  innerHTML: string;
  style: Record<string, string>;
  clientWidth: number;
  clientHeight: number;
  offsetLeft: number;
  offsetTop: number;
  listeners: Record<string, Array<(e: unknown) => void>>;
  appendChild(c: FakeEl): void;
  remove(): void;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  fire(t: string, e: unknown): void;
}

function el(tag: string): FakeEl {
  return {
    tag,
    textContent: "",
    srcObject: null,
    children: [],
    parent: null,
    innerHTML: "",
    style: {},
    clientWidth: 1280,
    clientHeight: 800,
    get offsetLeft() {
      return parseInt(this.style.left ?? "0", 10) || 0;
    },
    get offsetTop() {
      return parseInt(this.style.top ?? "0", 10) || 0;
    },
    listeners: {},
    appendChild(c) {
      c.parent = this;
      this.children.push(c);
    },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
    addEventListener(t, fn) {
      (this.listeners[t] ??= []).push(fn);
    },
    fire(t, e) {
      for (const fn of this.listeners[t] ?? []) fn(e);
    },
  };
}

function fakeWin() {
  const body = el("body");
  const w = {
    closed: false,
    focused: 0,
    document: { title: "", documentElement: el("html"), body, createElement: el },
    listeners: {} as Record<string, Array<() => void>>,
    addEventListener(t: string, fn: () => void) {
      (this.listeners[t] ??= []).push(fn);
    },
    focus() {
      this.focused++;
    },
    close() {
      this.closed = true;
      for (const fn of this.listeners.pagehide ?? []) fn();
    },
    stage() {
      return body.children[0];
    },
    tiles() {
      return this.stage()?.children ?? [];
    },
  };
  return w;
}

function fakeHost(opts: { blocked?: boolean } = {}) {
  const opened: ReturnType<typeof fakeWin>[] = [];
  const host = {
    screen: { availWidth: 1920, availHeight: 1080 },
    addEventListener() {},
    open() {
      if (opts.blocked) return null;
      const w = fakeWin();
      opened.push(w);
      return w;
    },
  };
  return { host: host as unknown as Window, opened };
}

const stream = (id: string) => ({ id }) as unknown as MediaStream;

test("openBoard lays every tile out in one window, videos muted, self mirrored", async () => {
  closeBoard();
  const { host, opened } = fakeHost();
  const tiles = [
    { key: "me", stream: stream("me"), label: "you", mirrored: true },
    { key: "a", stream: stream("a"), label: "ada" },
    { key: "b", stream: stream("b"), label: "bea" },
  ];
  assert.equal(await openBoard(tiles, host), true);
  assert.equal(opened.length, 1);
  assert.equal(boardOpen(), true);
  const w = opened[0];
  assert.equal(w.document.title, "chalk — call");
  assert.equal(w.tiles().length, 3);
  const [me, a] = w.tiles();
  assert.equal(me.children[0].textContent, "you");
  assert.equal(me.children[1].tag, "video");
  assert.equal(me.children[1].muted, true);
  assert.equal(me.children[1].style.transform, "scaleX(-1)");
  assert.equal(a.children[1].style.transform, undefined);
  assert.equal(me.style.resize, "both", "the corner is the browser's resize handle");
  // A second open raises and resyncs rather than doubling.
  assert.equal(await openBoard(tiles, host), true);
  assert.equal(opened.length, 1);
  assert.equal(w.focused, 2);
  closeBoard();
  assert.equal(boardOpen(), false);
  assert.equal(w.closed, true);
});

test("syncBoard drops the gone, follows a swapped stream, adds the new", async () => {
  closeBoard();
  const { host, opened } = fakeHost();
  await openBoard(
    [
      { key: "a", stream: stream("a"), label: "ada" },
      { key: "b", stream: stream("b"), label: "bea" },
    ],
    host,
  );
  const w = opened[0];
  const a2 = stream("a2");
  syncBoard([
    { key: "a", stream: a2, label: "ada — screen" },
    { key: "c", stream: stream("c"), label: "cid" },
  ]);
  const tiles = w.tiles();
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].children[1].srcObject, a2);
  assert.equal(tiles[0].children[0].textContent, "ada — screen");
  assert.equal(tiles[1].children[0].textContent, "cid");
  // An empty call leaves the board open: closing it is the person's call.
  syncBoard([]);
  assert.equal(w.tiles().length, 0);
  assert.equal(boardOpen(), true);
  closeBoard();
});

test("a tile drags by its strip, stays on the board, and comes to the front", async () => {
  closeBoard();
  const { host, opened } = fakeHost();
  await openBoard(
    [
      { key: "a", stream: stream("a"), label: "ada" },
      { key: "b", stream: stream("b"), label: "bea" },
    ],
    host,
  );
  const [a, b] = opened[0].tiles();
  const strip = a.children[0];
  const before = { left: a.style.left, top: a.style.top };
  const at = (x: number, y: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
  strip.fire("pointerdown", at(a.offsetLeft + 10, a.offsetTop + 10));
  strip.fire("pointermove", at(a.offsetLeft + 110, a.offsetTop + 60));
  strip.fire("pointerup", at(0, 0));
  assert.equal(parseInt(a.style.left, 10), parseInt(before.left, 10) + 100);
  assert.equal(parseInt(a.style.top, 10), parseInt(before.top, 10) + 50);
  // After the drag, a move without a press does nothing.
  strip.fire("pointermove", at(5000, 5000));
  assert.equal(parseInt(a.style.left, 10), parseInt(before.left, 10) + 100);
  // Dragging past the edge stops where the strip is still reachable.
  strip.fire("pointerdown", at(a.offsetLeft + 10, a.offsetTop + 10));
  strip.fire("pointermove", at(9000, 9000));
  strip.fire("pointerup", at(0, 0));
  assert.ok(parseInt(a.style.left, 10) <= 1280 - 160);
  assert.ok(parseInt(a.style.top, 10) <= 800 - 22);
  // Touching b raises it above a.
  b.fire("pointerdown", at(0, 0));
  assert.ok(Number(b.style.zIndex) > Number(a.style.zIndex));
  closeBoard();
});

test("a closed window, a blocked pop-up and an empty call all report honestly", async () => {
  closeBoard();
  const { host, opened } = fakeHost();
  let notes = 0;
  const stop = subscribeBoard(() => notes++);
  await openBoard([{ key: "a", stream: stream("a"), label: "ada" }], host);
  opened[0].close(); // the person closed the window
  assert.equal(boardOpen(), false);
  assert.equal(notes, 2);
  stop();
  assert.equal(await openBoard([], host), false, "nothing with video to show");
  const blocked = fakeHost({ blocked: true });
  assert.equal(await openBoard([{ key: "a", stream: stream("a"), label: "ada" }], blocked.host), false);
  assert.equal(boardOpen(), false);
});

test("with the on-top pref the board takes document PiP when it is free", async () => {
  closeBoard();
  const { host, opened } = fakeHost();
  const pipWin = fakeWin();
  const pip = {
    window: null as unknown,
    requestWindow: async () => {
      pip.window = pipWin;
      return pipWin as unknown as Window;
    },
  };
  (host as unknown as { documentPictureInPicture: unknown }).documentPictureInPicture = pip;
  await openBoard([{ key: "a", stream: stream("a"), label: "ada" }], host, { onTop: true });
  assert.equal(opened.length, 0);
  assert.equal(pipWin.tiles().length, 1);
  closeBoard();
  await openBoard([{ key: "a", stream: stream("a"), label: "ada" }], host);
  assert.equal(opened.length, 1, "without the pref the floating window is left alone");
  closeBoard();
});
