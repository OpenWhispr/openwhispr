// Match Expo Router's context while excluding Android-only route entries.
// Keep this list aligned with the platform-route-resolution regression check.
export const ctx = require.context(
  process.env.EXPO_ROUTER_APP_ROOT,
  true,
  /^\.\/(?!(?:.*\+api|\+html|\+middleware)\.[tj]sx?$)(?!.*\.(?:android|web)\.[tj]sx?$)(?!android-(?:assistant|models|permissions|pro|setup)\.[tj]sx?$)(?!\(account\)\/(?:device-check|help)\.[tj]sx?$)(?!\(tabs\)\/\(notes\)\/import-audio\.[tj]sx?$)(?!\(tabs\)\/\(style\)\/).*\.[tj]sx?$/,
  process.env.EXPO_ROUTER_IMPORT_MODE,
);
