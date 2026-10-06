// Single owner of the pill window's size priority: panel > menu > toast >
// compact listening pill > base. The assistant panel must never be collapsed
// by a toast dismissing underneath it, nor the listening pill clipped by a menu
// closing — higher states always win.
export const SIZE_RANK = {
  BASE: 0,
  WITH_LANGUAGE: 1,
  RECORDING: 2,
  DICTATION_ERROR: 3,
  DICTATION_ERROR_WITH_TRANSCRIPT: 4,
  WITH_MENU: 5,
  WITH_MENU_LANGUAGE: 5,
  WITH_TOAST: 6,
  EXPANDED: 7,
  ASSISTANT: 8,
};

export function resolveMainWindowSizeKey({
  panelOpen,
  menuOpen,
  menuIncludesLanguage = false,
  toastCount,
  compactPill,
  dictationErrorActionCount = 0,
  wantsLanguageWidth = false,
}) {
  if (panelOpen) return "ASSISTANT";
  if (dictationErrorActionCount > 1) return "DICTATION_ERROR_WITH_TRANSCRIPT";
  if (dictationErrorActionCount === 1) return "DICTATION_ERROR";
  if (menuOpen && (toastCount > 0 || compactPill)) return "EXPANDED";
  if (menuOpen) return menuIncludesLanguage ? "WITH_MENU_LANGUAGE" : "WITH_MENU";
  if (toastCount > 0) return "WITH_TOAST";
  if (compactPill) return wantsLanguageWidth ? "WITH_LANGUAGE" : "RECORDING";
  return wantsLanguageWidth ? "WITH_LANGUAGE" : "BASE";
}
