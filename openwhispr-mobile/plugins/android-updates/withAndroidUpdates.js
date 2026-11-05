const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

module.exports = function withAndroidUpdates(config) {
  if (!config.extra?.openWhispr?.isDevelopment) return config;
  return withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      'expo.modules.updates.ENABLED',
      'false',
    );
    return mod;
  });
};
