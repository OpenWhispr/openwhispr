export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element?.isContentEditable || element?.tagName === "INPUT" || element?.tagName === "TEXTAREA"
  );
}

export function getSelectionInside(root: HTMLElement | null): string | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !root) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  const text = selection.toString();
  return text.trim() ? text : null;
}

export function getSelectionForCopyShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "target">,
  root: HTMLElement | null
): string | null {
  if (
    isEditableTarget(event.target) ||
    event.key.toLowerCase() !== "c" ||
    event.altKey ||
    (!event.ctrlKey && !event.metaKey)
  ) {
    return null;
  }

  return getSelectionInside(root);
}
