const { withNativeWind } = require('nativewind/metro');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

// Add support for Whisper model files
config.resolver.assetExts.push(
  'bin', // Whisper model binary files
  'mil', // Core ML model files (iOS)
);

const platformConfig = withNativeWind(config, { input: './global.css' });
const resolveRequest = platformConfig.resolver.resolveRequest;
const iosRouterContext = require.resolve('expo-router/_ctx.ios.js');
const isolatedIosRouterContext = require.resolve('./config/router-context.ios.js');

// Expo Router collects opposite-platform routes before selecting the active one.
// Keep Android-only route modules out of the iOS bundle, preserving other resolvers.
platformConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = resolveRequest(context, moduleName, platform);
  if (
    platform === 'ios' &&
    resolved.type === 'sourceFile' &&
    resolved.filePath === iosRouterContext
  ) {
    return { type: 'sourceFile', filePath: isolatedIosRouterContext };
  }
  return resolved;
};

module.exports = platformConfig;
