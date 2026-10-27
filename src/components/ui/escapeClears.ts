/**
 * Marks a field whose Escape clears it instead of closing the dialog around it. Radix handles
 * Escape on the document in the capture phase, before the field's own key handler runs, so a
 * dialog has to ask whether the target opted in. Set the attribute only while there is
 * something to clear, so an empty field still lets Escape close the dialog.
 */
export const ESCAPE_CLEARS_ATTRIBUTE = "data-escape-clears";

export function escapeClearsTarget(event: KeyboardEvent): boolean {
  const { target } = event;
  return target instanceof Element && target.closest(`[${ESCAPE_CLEARS_ATTRIBUTE}]`) !== null;
}
