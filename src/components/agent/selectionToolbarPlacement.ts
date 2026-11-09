/** Where the selection is, and the chat's visible area the toolbar stays inside. */
export interface ToolbarAnchor {
  rect: Pick<DOMRect, "top" | "bottom" | "left">;
  bounds: Pick<DOMRect, "top" | "bottom" | "left" | "right">;
}

// Between the toolbar and the selection, and the toolbar and the chat's edges.
const GAP_PX = 8;
const EDGE_PX = 8;

/**
 * The selection toolbar's place: below the selection, or above it when the
 * chat has no room below, and always inside the chat, whatever its
 * translated width.
 */
export function placeSelectionToolbar(
  { rect, bounds }: ToolbarAnchor,
  size: { width: number; height: number }
): { top: number; left: number } {
  const below = rect.bottom + GAP_PX;
  const top =
    below + size.height <= bounds.bottom - EDGE_PX
      ? below
      : Math.max(bounds.top + EDGE_PX, rect.top - GAP_PX - size.height);
  const left = Math.max(
    bounds.left + EDGE_PX,
    Math.min(rect.left, bounds.right - EDGE_PX - size.width)
  );
  return { top, left };
}
