// Android's routes live in app-android/, apart from the iOS app's app/. Same filter as Expo
// Router's stock context; Android-only, so no route file is shared with iOS.
export const ctx = require.context(
  '../app-android',
  true,
  /^\.\/(?!(?:.*\+api|\+html|\+middleware)\.[tj]sx?$)(?!(?:.*\/)?__tests__\/).*\.[tj]sx?$/,
  process.env.EXPO_ROUTER_IMPORT_MODE,
);
