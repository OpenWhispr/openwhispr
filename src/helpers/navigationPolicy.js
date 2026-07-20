// Control panel navigation policy.
//
// The control panel is the only window that renders arbitrary HTML from
// outside the app (e.g. update release notes via dangerouslySetInnerHTML),
// so its will-navigate handler must tell the app's own content apart from
// anything else and hand the "anything else" off to the OS browser instead
// of navigating the window itself.

// Whether a navigation target is the app's own content and should be left
// alone (return true) rather than redirected to the OS browser.
//
// appUrl is the control panel's own URL, and is only non-null in development
// (loadURL() against the dev server). Production loads via loadFile(), so
// appUrl is null there and only the file:// branch matters.
export function isInternalNavigation(url, appUrl) {
  return Boolean(
    (appUrl && url.startsWith(appUrl)) ||
      url.startsWith("file://") ||
      url.startsWith("devtools://")
  );
}
