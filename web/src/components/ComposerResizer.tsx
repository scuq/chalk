// Phase 91-1: drag handle on the divider above the composer.
//
// The horizontal analogue of SidebarResizer, and it works the same way: the
// live height is owned by the parent so the footer can follow the pointer at
// 60fps, and the prefs round-trip happens once per gesture. Drag up for a
// taller field, arrow keys to nudge, double-click to go back to auto.

import { useEffect, useRef } from "preact/hooks";
import {
  COMPOSER_HEIGHT_AUTO,
  COMPOSER_HEIGHT_MAX,
  COMPOSER_HEIGHT_MIN,
  COMPOSER_HEIGHT_STEP,
  clampComposerDrag,
} from "../chat/composer-height";

interface Props {
  // The pref-driven height, or COMPOSER_HEIGHT_AUTO for "no explicit height"
  // -- which is left off aria-valuenow rather than announced as "0".
  height: number;
  // Called continuously during a drag. Not persisted.
  onPreview: (height: number) => void;
  // Called once when a gesture ends, with the height to persist.
  onCommit: (height: number) => void;
}

export function ComposerResizer({ height, onPreview, onCommit }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Where the pointer went down and how tall the field was then. Deltas are
  // measured from that origin rather than from the previous move event, so a
  // drag that leaves the window and comes back doesn't accumulate drift.
  const origin = useRef<{ y: number; height: number } | null>(null);

  // The field this handle resizes. Looked up from the footer rather than
  // passed down: the textarea belongs to Composer, and threading a ref up
  // through the footer for one measurement would put layout plumbing in the
  // middle of the message path.
  const field = (): HTMLTextAreaElement | null =>
    rootRef.current?.parentElement?.querySelector<HTMLTextAreaElement>(
      ".chalk-composer-input",
    ) ?? null;

  // A gesture starts from the height on screen, not from the pref: the
  // textarea's own corner grip writes an inline height that the pref knows
  // nothing about, and starting from the stored value would make the field
  // jump on the first pixel of movement.
  const measured = (): number => {
    const el = field();
    const px = el ? Math.round(el.getBoundingClientRect().height) : 0;
    return px > 0 ? px : height || COMPOSER_HEIGHT_MIN;
  };

  // That same inline height outranks the custom property the pref drives, so
  // whatever the grip left is dropped the moment this handle sets a height.
  // Done here rather than on pointer-down so a click that never moves doesn't
  // flash the field back to its default and straight out again.
  const releaseGrip = () => {
    const el = field();
    if (el) el.style.height = "";
  };

  // The pointer can outrun the handle, so moves and releases are tracked on
  // the window rather than the element.
  useEffect(() => {
    const heightAt = (clientY: number): number =>
      clampComposerDrag(
        origin.current!.height + (origin.current!.y - clientY),
        window.innerHeight,
      );
    function onMove(e: PointerEvent) {
      if (!origin.current) return;
      e.preventDefault();
      releaseGrip();
      onPreview(heightAt(e.clientY));
    }
    function onUp(e: PointerEvent) {
      if (!origin.current) return;
      const next = heightAt(e.clientY);
      origin.current = null;
      document.body.classList.remove("chalk-resizing-y");
      onCommit(next);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [onPreview, onCommit]);

  // Drop the drag-cursor class if we unmount mid-gesture (window narrows to
  // mobile, logout) -- otherwise the whole document keeps a resize cursor.
  useEffect(() => () => document.body.classList.remove("chalk-resizing-y"), []);

  const nudge = (delta: number) => {
    const next = clampComposerDrag(measured() + delta, window.innerHeight);
    releaseGrip();
    onCommit(next);
  };

  const reset = () => {
    releaseGrip();
    // Back to two rows at whatever the UI scale is -- which is what auto
    // means, and why the reset isn't a px value.
    onCommit(COMPOSER_HEIGHT_AUTO);
  };

  return (
    <div
      ref={rootRef}
      class="chalk-composer-resizer"
      data-testid="composer-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label="resize the message box"
      aria-valuenow={height > 0 ? height : undefined}
      aria-valuemin={COMPOSER_HEIGHT_MIN}
      aria-valuemax={COMPOSER_HEIGHT_MAX}
      tabIndex={0}
      title="drag to resize the message box — double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        e.preventDefault();
        origin.current = { y: e.clientY, height: measured() };
        document.body.classList.add("chalk-resizing-y");
      }}
      onDblClick={reset}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          nudge(COMPOSER_HEIGHT_STEP);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          nudge(-COMPOSER_HEIGHT_STEP);
        } else if (e.key === "Home") {
          e.preventDefault();
          reset();
        }
      }}
    />
  );
}
