// Single owner of the pill window's size priority: panel > menu > toast >
// recording capsule > base. The assistant panel must never be collapsed by a
// toast dismissing underneath it, nor the recording capsule clipped by a menu
// closing — higher states always win.
export const SIZE_RANK = { BASE: 0, RECORDING: 1, WITH_MENU: 2, WITH_TOAST: 3, EXPANDED: 4 };

export function resolveMainWindowSizeKey({ panelOpen, menuOpen, toastCount, capsule }) {
  if (panelOpen) return "EXPANDED";
  if (menuOpen && (toastCount > 0 || capsule)) return "EXPANDED";
  if (menuOpen) return "WITH_MENU";
  if (toastCount > 0) return "WITH_TOAST";
  if (capsule) return "RECORDING";
  return "BASE";
}
