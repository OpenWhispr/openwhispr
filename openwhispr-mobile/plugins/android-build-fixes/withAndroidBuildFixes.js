const {
  withAndroidManifest,
  withDangerousMod,
  withProjectBuildGradle,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// react-native-appsflyer 7 compiles against kotlin-stdlib 2.4.x unless the root
// project sets `kotlin_stdlib_version`. The app compiles with React Native's
// Kotlin (kotlinVersion, set by the expo-root-project plugin from RN's version
// catalog), which can't read 2.4 metadata, so compileReleaseKotlin fails with
// "Module was compiled with an incompatible version of Kotlin". Pin the stdlib
// to the compiler's version; this must follow the expo-root-project plugin.
const ROOT_PROJECT_PLUGIN = 'apply plugin: "expo-root-project"';
const KOTLIN_STDLIB_SNIPPET = `
// withAndroidBuildFixes: keep react-native-appsflyer on the app's Kotlin version
ext.kotlin_stdlib_version = ext.kotlinVersion
`;

function pinKotlinStdlib(contents) {
  if (contents.includes(KOTLIN_STDLIB_SNIPPET)) return contents;
  if (!contents.includes(ROOT_PROJECT_PLUGIN)) {
    throw new Error(
      'withAndroidBuildFixes: expo-root-project plugin not found in the generated build.gradle',
    );
  }
  return contents.replace(ROOT_PROJECT_PLUGIN, ROOT_PROJECT_PLUGIN + '\n' + KOTLIN_STDLIB_SNIPPET);
}

// expo-secure-store sets android:dataExtractionRules and android:fullBackupContent
// to keep its Keystore-encrypted values out of backups (they can't be decrypted
// after a restore). The AppsFlyer SDK's manifest sets both too, and its plugin
// leaves the app's values in place (preferAppsFlyerBackupRules=false) without
// resolving the conflict, so the manifest merge fails. Keep the app's values.
const BACKUP_ATTRIBUTES = ['android:dataExtractionRules', 'android:fullBackupContent'];

function keepAppBackupRules(manifest) {
  manifest.manifest.$['xmlns:tools'] ??= 'http://schemas.android.com/tools';
  const application = manifest.manifest.application?.[0];
  if (!application) return manifest;

  const attrs = application.$;
  const present = BACKUP_ATTRIBUTES.filter((name) => attrs[name] !== undefined);
  if (present.length === 0) return manifest;

  const replaced = (attrs['tools:replace'] ?? '').split(',').filter(Boolean);
  attrs['tools:replace'] = [...new Set([...replaced, ...present])].join(',');
  return manifest;
}

// The Android theme Expo generates always points windowSplashScreenAnimatedIcon
// at @drawable/splashscreen_logo, which only exists when the splash config has
// an image. This app's splash is a plain color, so resource linking fails.
// Add a transparent icon, matching the color-only iOS splash.
const SPLASH_LOGO = 'splashscreen_logo';
const TRANSPARENT_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<color xmlns:android="http://schemas.android.com/apk/res/android" android:color="@android:color/transparent" />
`;

function addMissingSplashLogo(resDir) {
  const hasLogo = fs
    .readdirSync(resDir)
    .filter((dir) => dir.startsWith('drawable'))
    .some((dir) =>
      fs.readdirSync(path.join(resDir, dir)).some((file) => file.startsWith(`${SPLASH_LOGO}.`)),
    );
  if (hasLogo) return false;

  fs.mkdirSync(path.join(resDir, 'drawable'), { recursive: true });
  fs.writeFileSync(path.join(resDir, 'drawable', `${SPLASH_LOGO}.xml`), TRANSPARENT_DRAWABLE);
  return true;
}

function withAndroidBuildFixes(config) {
  config = withProjectBuildGradle(config, (cfg) => {
    cfg.modResults.contents = pinKotlinStdlib(cfg.modResults.contents);
    return cfg;
  });
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = keepAppBackupRules(cfg.modResults);
    return cfg;
  });
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      addMissingSplashLogo(path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res'));
      return cfg;
    },
  ]);
}

module.exports = withAndroidBuildFixes;
module.exports.pinKotlinStdlib = pinKotlinStdlib;
module.exports.keepAppBackupRules = keepAppBackupRules;
module.exports.addMissingSplashLogo = addMissingSplashLogo;
