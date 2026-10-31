const { withAndroidManifest } = require('@expo/config-plugins');

// SecureStore credentials cannot be restored on another device. Keep Expo's
// exclusions when the attribution SDK also contributes backup rules.
module.exports = (config) =>
  withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    const app = manifest.application[0];
    const replacements = new Set((app.$['tools:replace'] || '').split(',').filter(Boolean));
    replacements.add('android:dataExtractionRules');
    replacements.add('android:fullBackupContent');
    app.$['tools:replace'] = [...replacements].join(',');
    return result;
  });
