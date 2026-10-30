export function getSelectionInside(root: HTMLElement | null): string | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !root) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  const text = selection.toString();
  return text.trim() ? text : null;
}
