const PRODUCTION_BUNDLE_ID = 'com.gizmolabs.openwhispr';
const DEVELOPMENT_BUNDLE_ID = 'com.gizmolabs.openwhispr.dev';

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function normalizeEnvironment(rawValue) {
  const value = String(rawValue || '')
    .trim()
    .toLowerCase();
  if (['dev', 'development', 'local'].includes(value)) return 'development';
  if (['prod', 'production', 'testflight', 'release'].includes(value)) return 'production';
  return 'production';
}

function deriveAppGroupId(bundleIdentifier) {
  return `group.${bundleIdentifier}`;
}

function resolveOpenWhisprEnvironment() {
  const appEnvironment = normalizeEnvironment(
    firstNonEmpty(
      process.env.OPENWHISPR_APP_ENV,
      process.env.APP_ENV,
      process.env.EAS_BUILD_PROFILE,
    ),
  );
  const isDevelopment = appEnvironment === 'development';
  const defaultBundleId = isDevelopment ? DEVELOPMENT_BUNDLE_ID : PRODUCTION_BUNDLE_ID;
  const bundleIdentifier = firstNonEmpty(
    process.env.OPENWHISPR_IOS_BUNDLE_IDENTIFIER,
    process.env.OPENWHISPR_BUNDLE_IDENTIFIER,
    defaultBundleId,
  );
  const androidPackage = firstNonEmpty(
    process.env.OPENWHISPR_ANDROID_PACKAGE,
    process.env.OPENWHISPR_PACKAGE,
    bundleIdentifier,
  );
  const scheme = firstNonEmpty(
    process.env.OPENWHISPR_SCHEME,
    isDevelopment ? 'openwhispr-dev' : 'openwhispr',
  );
  const displayName = firstNonEmpty(
    process.env.OPENWHISPR_DISPLAY_NAME,
    isDevelopment ? 'OpenWhispr Dev' : 'OpenWhispr',
  );
  const keyboardDisplayName = firstNonEmpty(
    process.env.OPENWHISPR_KEYBOARD_DISPLAY_NAME,
    displayName,
  );
  const appGroupId = firstNonEmpty(
    process.env.OPENWHISPR_APP_GROUP_ID,
    deriveAppGroupId(bundleIdentifier),
  );
  const keyboardBundleIdentifier = firstNonEmpty(
    process.env.OPENWHISPR_KEYBOARD_BUNDLE_IDENTIFIER,
    `${bundleIdentifier}.keyboard`,
  );

  return {
    appEnvironment,
    isDevelopment,
    displayName,
    keyboardDisplayName,
    scheme,
    iosBundleIdentifier: bundleIdentifier,
    androidPackage,
    keyboardBundleIdentifier,
    appGroupId,
    notificationPrefix: bundleIdentifier,
  };
}

module.exports = {
  deriveAppGroupId,
  normalizeEnvironment,
  resolveOpenWhisprEnvironment,
};
