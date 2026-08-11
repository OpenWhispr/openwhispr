// macOS Dock icon policy.
//
// The Dock icon follows the control panel: it appears when the control panel
// opens and goes away when the panel is closed to the tray, so OpenWhispr
// lives in the menu bar like other background utilities.
//
// Hiding the dictation panel must never touch the Dock. The panel is hidden
// outright rather than minimized into the Dock, so there is nothing to restore
// from there.
//
// Menu-bar-only mode (#1380) overrides all of it: with hideDockIcon set the
// icon never appears, control panel or not, and the tray is the only way in.

// Whether the Dock icon should be visible right now.
// Returns null off macOS, where there is no Dock to act on.
export function resolveDockVisibility({ platform, controlPanelVisible, hideDockIcon }) {
  if (platform !== "darwin") return null;
  if (hideDockIcon) return false;
  return !!controlPanelVisible;
}
