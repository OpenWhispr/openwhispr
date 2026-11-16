const { withAppDelegate } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const RECOVERY_MARKER = '// MARK: - Background upload recovery';
const APP_DELEGATE_CLASS = /^class AppDelegate: ExpoAppDelegate \{/m;
const RECOVERY_CALLBACK = fs.readFileSync(
  path.join(__dirname, 'plugin', 'BackgroundUploadAppDelegate.swift'),
  'utf8',
);

function addBackgroundUploadRecovery(contents) {
  if (contents.includes(RECOVERY_MARKER)) return contents;
  if (!APP_DELEGATE_CLASS.test(contents)) {
    throw new Error('[background-uploader] Could not find the Expo AppDelegate class.');
  }
  return `import BackgroundUploader\n${contents.replace(
    APP_DELEGATE_CLASS,
    (declaration) => `${declaration}\n${RECOVERY_CALLBACK}`,
  )}`;
}

module.exports = function withBackgroundUploader(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('[background-uploader] Background recovery requires a Swift AppDelegate.');
    }
    cfg.modResults.contents = addBackgroundUploadRecovery(cfg.modResults.contents);
    return cfg;
  });
};
module.exports.addBackgroundUploadRecovery = addBackgroundUploadRecovery;
