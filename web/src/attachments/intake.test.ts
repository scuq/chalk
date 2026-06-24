// Tests for attachments/intake.ts -- the pure paste/drag file extractors.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  imageFilesFromClipboardItems,
  filesFromList,
  dragHasFiles,
  type ClipboardItemLike,
} from "./intake";

function fileOf(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function clipItem(kind: string, type: string, file: File | null): ClipboardItemLike {
  return { kind, type, getAsFile: () => file };
}

test("imageFilesFromClipboardItems captures only image file items", () => {
  const png = fileOf("shot.png", "image/png");
  const items = [
    clipItem("string", "text/plain", null), // pasted text -> ignored
    clipItem("file", "image/png", png), // a screenshot -> captured
    clipItem("file", "application/pdf", fileOf("x.pdf", "application/pdf")), // non-image file -> ignored here
  ];
  const out = imageFilesFromClipboardItems(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "shot.png");
});

test("imageFilesFromClipboardItems handles null/empty and missing files", () => {
  assert.deepEqual(imageFilesFromClipboardItems(null), []);
  assert.deepEqual(imageFilesFromClipboardItems(undefined), []);
  assert.deepEqual(imageFilesFromClipboardItems([]), []);
  // file-kind image item whose getAsFile returns null is skipped.
  assert.deepEqual(imageFilesFromClipboardItems([clipItem("file", "image/png", null)]), []);
});

test("filesFromList copies any files (drag-drop accepts non-images)", () => {
  const list = [fileOf("a.png", "image/png"), fileOf("b.pdf", "application/pdf")];
  const out = filesFromList(list);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.name), ["a.png", "b.pdf"]);
});

test("filesFromList handles null/empty", () => {
  assert.deepEqual(filesFromList(null), []);
  assert.deepEqual(filesFromList(undefined), []);
  assert.deepEqual(filesFromList([]), []);
});

test("dragHasFiles is true only when the drag carries files", () => {
  assert.equal(dragHasFiles(["Files"]), true);
  assert.equal(dragHasFiles(["text/plain", "Files"]), true);
  assert.equal(dragHasFiles(["text/plain"]), false);
  assert.equal(dragHasFiles([]), false);
  assert.equal(dragHasFiles(null), false);
  assert.equal(dragHasFiles(undefined), false);
});
