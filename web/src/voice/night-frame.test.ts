// 129-6: the night frame module keeps every live frame in step.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mountNightFrame, nightFrameCount, setNightFrame } from "./night-frame";

// The subset of a Document and an element the module touches.
class FakeEl {
  style: Record<string, string> = {};
  className = "";
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  appendChild(c: FakeEl) {
    c.parent = this;
    this.children.push(c);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}
function fakeDoc() {
  const made: FakeEl[] = [];
  const doc = {
    createElement() {
      const el = new FakeEl();
      made.push(el);
      return el as unknown as HTMLElement;
    },
  } as unknown as Document;
  return { doc, made };
}

test("a frame mounted before the night is hidden, lights up with the night, and goes dark after", () => {
  setNightFrame(null);
  const { doc, made } = fakeDoc();
  const container = new FakeEl();
  const off = mountNightFrame(doc, container as unknown as HTMLElement);
  assert.equal(made.length, 1);
  assert.equal(made[0].style.display, "none");
  assert.equal(made[0].style.pointerEvents, "none");
  assert.equal(container.children.length, 1);
  setNightFrame({ line: "rgba(1, 2, 3, 0.5)", glow: "rgba(4, 5, 6, 0.4)" });
  assert.equal(made[0].style.display, "block");
  assert.match(made[0].style.boxShadow, /inset 0 0 0 2px rgba\(1, 2, 3, 0.5\)/);
  assert.match(made[0].style.boxShadow, /inset 0 0 28px 6px rgba\(4, 5, 6, 0.4\)/);
  setNightFrame(null);
  assert.equal(made[0].style.display, "none");
  off();
  assert.equal(container.children.length, 0);
  assert.equal(nightFrameCount(), 0);
});

test("a frame mounted during the night is lit at once, and an unmounted one is forgotten", () => {
  setNightFrame({ line: "a", glow: "b" });
  const { doc, made } = fakeDoc();
  const off = mountNightFrame(doc, new FakeEl() as unknown as HTMLElement);
  assert.equal(made[0].style.display, "block");
  assert.equal(nightFrameCount(), 1);
  off();
  setNightFrame(null);
  assert.equal(made[0].style.display, "block", "a removed frame is no longer repainted");
  assert.equal(nightFrameCount(), 0);
});
