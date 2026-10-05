// Single owner of the pill window's size priority: panel > menu > toast >
// compact listening pill > base. The assistant panel must never be collapsed
// by a toast dismissing underneath it, nor the listening pill clipped by a menu
// closing — higher states always win.
export const SIZE_RANK = {
  BASE: 0,
  RECORDING: 1,
  DICTATION_ERROR: 2,
  DICTATION_ERROR_WITH_TRANSCRIPT: 3,
  WITH_MENU: 4,
  WITH_TOAST: 5,
  EXPANDED: 6,
  ASSISTANT: 7,
};

export function resolveMainWindowSizeKey({
  panelOpen,
  menuOpen,
  toastCount,
  compactPill,
  dictationErrorActionCount = 0,
}) {
  if (panelOpen) return "ASSISTANT";
  if (dictationErrorActionCount > 1) return "DICTATION_ERROR_WITH_TRANSCRIPT";
  if (dictationErrorActionCount === 1) return "DICTATION_ERROR";
  if (menuOpen && (toastCount > 0 || compactPill)) return "EXPANDED";
  if (menuOpen) return "WITH_MENU";
  if (toastCount > 0) return "WITH_TOAST";
  if (compactPill) return "RECORDING";
  return "BASE";
}
