const { withPlatformNativeWind } = require('./config/platform-styles');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

// Add support for Whisper model files
config.resolver.assetExts.push(
  'bin', // Whisper model binary files
  'mil', // Core ML model files (iOS)
);

const platformConfig = withPlatformNativeWind(config, { input: './global.css' });
const resolveRequest = platformConfig.resolver.resolveRequest;
const iosRouterContext = require.resolve('expo-router/_ctx.ios.js');
const isolatedIosRouterContext = require.resolve('./config/router-context.ios.js');
const androidRouterContext = require.resolve('expo-router/_ctx.android.js');
const isolatedAndroidRouterContext = require.resolve('./config/router-context.android.js');

// Expo Router collects opposite-platform routes before selecting the active one.
// Keep Android-only route modules out of the iOS bundle, and give Android its own
// route tree (app-android/), preserving other resolvers.
platformConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = resolveRequest(context, moduleName, platform);
  if (resolved.type !== 'sourceFile') return resolved;
  if (platform === 'ios' && resolved.filePath === iosRouterContext) {
    return { type: 'sourceFile', filePath: isolatedIosRouterContext };
  }
  if (platform === 'android' && resolved.filePath === androidRouterContext) {
    return { type: 'sourceFile', filePath: isolatedAndroidRouterContext };
  }
  return resolved;
};

module.exports = platformConfig;
