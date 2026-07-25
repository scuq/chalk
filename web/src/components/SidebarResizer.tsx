// Phase 33-4: drag handle on the sidebar's right edge.
//
// Drag to resize, arrow keys to nudge, double-click to reset. The live width
// is owned by the parent so the grid can follow the pointer at 60fps; this
// component only reports deltas and tells the parent when a gesture ends, so
// the prefs round-trip happens once per drag instead of once per frame.

import { useEffect, useRef } from "preact/hooks";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
  clampSidebarWidth,
} from "../chat/sidebar-width";

interface Props {
  width: number;
  // Called continuously during a drag. Not persisted.
  onPreview: (width: number) => void;
  // Called once when a gesture ends, with the width to persist.
  onCommit: (width: number) => void;
}

export function SidebarResizer({ width, onPreview, onCommit }: Props) {
  // Where the pointer went down, and how wide the sidebar was then. Deltas
  // are measured from that origin rather than from the previous move event,
  // so a drag that leaves the window and comes back doesn't accumulate drift.
  const origin = useRef<{ x: number; width: number } | null>(null);

  // The pointer can outrun the handle, so moves and releases are tracked on
  // the window rather than the element. Registered only while dragging.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!origin.current) return;
      e.preventDefault();
      onPreview(clampSidebarWidth(origin.current.width + (e.clientX - origin.current.x)));
    }
    function onUp(e: PointerEvent) {
      if (!origin.current) return;
      const next = clampSidebarWidth(origin.current.width + (e.clientX - origin.current.x));
      origin.current = null;
      document.body.classList.remove("chalk-resizing");
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
  useEffect(() => () => document.body.classList.remove("chalk-resizing"), []);

  return (
    <div
      class="chalk-sidebar-resizer"
      data-testid="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      title="drag to resize — double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        e.preventDefault();
        origin.current = { x: e.clientX, width };
        document.body.classList.add("chalk-resizing");
      }}
      onDblClick={() => onCommit(SIDEBAR_WIDTH_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onCommit(clampSidebarWidth(width - SIDEBAR_WIDTH_STEP));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onCommit(clampSidebarWidth(width + SIDEBAR_WIDTH_STEP));
        } else if (e.key === "Home") {
          e.preventDefault();
          onCommit(SIDEBAR_WIDTH_DEFAULT);
        }
      }}
    />
  );
}
