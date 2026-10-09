// Destinations are fixed by built-in identity, never by editable copy or stored output.
/** @returns {"summary" | "chat" | null} */
export function getActionOutput(action) {
  if (action.kind === "template") return null;
  return action.kind === "action" &&
    action.is_builtin === 1 &&
    (action.translation_key === "notes.actions.builtin.shorten" ||
      action.translation_key === "notes.actions.builtin.lengthen")
    ? "summary"
    : "chat";
}
