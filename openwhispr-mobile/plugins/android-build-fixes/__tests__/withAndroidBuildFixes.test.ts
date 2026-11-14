import fs from 'fs';
import os from 'os';
import path from 'path';

const {
  addMissingSplashLogo,
  keepAppBackupRules,
  pinKotlinStdlib,
} = require('../withAndroidBuildFixes');

const EXPO_TEMPLATE_BUILD_GRADLE = `buildscript {
  dependencies {
    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
  }
}

apply plugin: "expo-root-project"
apply plugin: "com.facebook.react.rootproject"
`;

function manifestWith(applicationAttrs: Record<string, string>) {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' } as Record<
        string,
        string
      >,
      application: [{ $: { 'android:name': '.MainApplication', ...applicationAttrs } }],
    },
  };
}

describe('withAndroidBuildFixes', () => {
  describe('pinKotlinStdlib', () => {
    it('pins the stdlib to kotlinVersion after the expo-root-project plugin', () => {
      const gradle = pinKotlinStdlib(EXPO_TEMPLATE_BUILD_GRADLE);

      expect(gradle).toContain('ext.kotlin_stdlib_version = ext.kotlinVersion');
      expect(gradle.indexOf('ext.kotlin_stdlib_version')).toBeGreaterThan(
        gradle.indexOf('apply plugin: "expo-root-project"'),
      );
    });

    it('is idempotent across prebuilds', () => {
      const once = pinKotlinStdlib(EXPO_TEMPLATE_BUILD_GRADLE);

      expect(pinKotlinStdlib(once)).toBe(once);
    });

    it('fails loudly when the expo-root-project plugin is missing', () => {
      expect(() =>
        pinKotlinStdlib(EXPO_TEMPLATE_BUILD_GRADLE.replace('expo-root-project', 'other')),
      ).toThrow('withAndroidBuildFixes: expo-root-project plugin not found');
    });
  });

  describe('keepAppBackupRules', () => {
    it('keeps the app backup rules over the AppsFlyer SDK ones', () => {
      const manifest = keepAppBackupRules(
        manifestWith({
          'android:fullBackupContent': '@xml/secure_store_backup_rules',
          'android:dataExtractionRules': '@xml/secure_store_data_extraction_rules',
        }),
      );

      expect(manifest.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
      expect(manifest.manifest.application[0].$['tools:replace']).toBe(
        'android:dataExtractionRules,android:fullBackupContent',
      );
    });

    it('preserves existing tools:replace entries and stays idempotent', () => {
      const once = keepAppBackupRules(
        manifestWith({
          'android:fullBackupContent': '@xml/secure_store_backup_rules',
          'tools:replace': 'android:allowBackup',
        }),
      );
      const twice = keepAppBackupRules(once);

      expect(twice.manifest.application[0].$['tools:replace']).toBe(
        'android:allowBackup,android:fullBackupContent',
      );
    });

    it('leaves the manifest alone when the app sets no backup rules', () => {
      const manifest = keepAppBackupRules(manifestWith({}));

      expect(manifest.manifest.application[0].$['tools:replace']).toBeUndefined();
    });
  });

  describe('addMissingSplashLogo', () => {
    let resDir: string;

    beforeEach(() => {
      resDir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-res-'));
      fs.mkdirSync(path.join(resDir, 'drawable'));
      fs.mkdirSync(path.join(resDir, 'values'));
    });

    afterEach(() => {
      fs.rmSync(resDir, { recursive: true, force: true });
    });

    it('adds a transparent splash logo when the splash config has no image', () => {
      expect(addMissingSplashLogo(resDir)).toBe(true);

      const logo = fs.readFileSync(path.join(resDir, 'drawable', 'splashscreen_logo.xml'), 'utf8');
      expect(logo).toContain('android:color="@android:color/transparent"');
    });

    it('keeps a splash logo generated from an image', () => {
      fs.mkdirSync(path.join(resDir, 'drawable-xxhdpi'));
      fs.writeFileSync(path.join(resDir, 'drawable-xxhdpi', 'splashscreen_logo.png'), '');

      expect(addMissingSplashLogo(resDir)).toBe(false);
      expect(fs.existsSync(path.join(resDir, 'drawable', 'splashscreen_logo.xml'))).toBe(false);
    });
  });
});
