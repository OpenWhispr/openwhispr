// macOS Dock icon policy.
//
// The Dock icon follows the control panel: it appears when the control panel
// opens and goes away when the panel is closed to the tray, so OpenWhispr
// lives in the menu bar like other background utilities.
//
// Hiding the dictation panel must never touch the Dock. The panel is hidden
// outright rather than minimized into the Dock, so there is nothing to restore
// from there.

// Whether the Dock icon should be visible right now.
// Returns null off macOS, where there is no Dock to act on.
export function resolveDockVisibility({ platform, controlPanelVisible }) {
  if (platform !== "darwin") return null;
  return !!controlPanelVisible;
}
