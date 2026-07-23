// macOS Accessibility registration policy.
//
// macOS only lists an app under Privacy & Security > Accessibility once that
// app has *asked* for the permission. Every check OpenWhispr makes passes
// `false` to isTrustedAccessibilityClient, which queries without registering,
// so an install that has never prompted does not appear in the list at all.
// Sending that user to System Settings is a dead end: there is no row to
// enable, and the pane gives no hint that the app must ask first.
//
// The prompt is deliberately one-shot. macOS shows a modal TCC dialog that
// cannot be suppressed once triggered, so firing it on every attempt would be
// worse than the dead end it fixes. One prompt is enough — it creates the row,
// after which System Settings is actionable forever.

// Whether to trigger the registering TCC prompt before opening System Settings.
// Returns false off macOS, where there is no Accessibility permission to grant.
export function shouldPromptForAccessibility({ platform, alreadyGranted, hasPromptedBefore }) {
  if (platform !== "darwin") return false;
  if (alreadyGranted) return false;
  return !hasPromptedBefore;
}
