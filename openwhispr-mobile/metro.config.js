const path = require('node:path');
const { withNativeWind } = require('nativewind/metro');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

// Shared source is portable; runtime packages belong to the mobile app.
config.watchFolders = [path.resolve(__dirname, '../shared')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
// Keep nested mobile dependencies visible without exposing desktop packages.
config.resolver.disableHierarchicalLookup = false;
const desktopModules = path
  .resolve(__dirname, '../node_modules')
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const existingBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList)
    ? existingBlockList
    : existingBlockList
      ? [existingBlockList]
      : []),
  new RegExp(`^${desktopModules}($|[/\\\\])`),
];

// Add support for Whisper model files
config.resolver.assetExts.push(
  'bin', // Whisper model binary files
  'mil', // Core ML model files (iOS)
);

module.exports = withNativeWind(config, { input: './global.css' });
