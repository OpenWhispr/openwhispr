import { BUILTIN_ACTIONS } from "./builtinActions.js";

// Destinations are fixed by built-in identity, never by editable copy or stored output.
/** @returns {"summary" | "chat" | null} */
export function getActionOutput(action) {
  if (action.kind === "template") return null;
  const builtin =
    action.is_builtin === 1 &&
    BUILTIN_ACTIONS.find((entry) => entry.translationKey === action.translation_key);
  return builtin?.output === "summary" ? "summary" : "chat";
}
