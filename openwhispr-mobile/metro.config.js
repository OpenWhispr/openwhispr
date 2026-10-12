const { withNativeWind } = require('nativewind/metro');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

// Add support for Whisper model files
config.resolver.assetExts.push(
  'bin', // Whisper model binary files
  'mil', // Core ML model files (iOS)
);

module.exports = withNativeWind(config, { input: './global.css' });
