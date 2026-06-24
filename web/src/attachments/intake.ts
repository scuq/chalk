// chalk att-3 -- composer intake helpers (clipboard paste + drag-drop).
//
// Pure functions that pull File objects out of a paste or drop event, kept
// separate from Composer.tsx so they're unit-testable without a DOM. They are
// typed structurally (ClipboardItemLike / ArrayLike<File>) so the real
// DataTransferItemList / FileList satisfy them and tests can pass plain stubs.

/** The slice of DataTransferItem these helpers read. */
export interface ClipboardItemLike {
  kind: string; // "file" | "string"
  type: string; // mime
  getAsFile(): File | null;
}

/**
 * imageFilesFromClipboardItems extracts image Files from a paste's
 * clipboardData.items. This is the "paste a screenshot" path: only file-kind
 * items with an image/* type are captured; pasted text is ignored here (it
 * flows through the textarea normally). Returns [] when there are no images.
 */
export function imageFilesFromClipboardItems(
  items: ArrayLike<ClipboardItemLike> | null | undefined,
): File[] {
  if (!items) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * filesFromList copies a FileList (or any ArrayLike<File>) into a plain array.
 * Used by the drop handler -- drag-drop accepts ANY file type, not just images
 * (the feed renders non-images as a file row). Returns [] when empty/absent.
 */
export function filesFromList(files: ArrayLike<File> | null | undefined): File[] {
  if (!files || files.length === 0) return [];
  const out: File[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f) out.push(f);
  }
  return out;
}

/** hasFiles reports whether a drag event's dataTransfer carries any files (vs
 *  a text/selection drag), so the composer only shows the drop affordance for
 *  actual file drags. */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}
