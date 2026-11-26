import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFingerprint,
  diffFingerprints,
  extractStyleData,
  fileViolations,
  isAndroidOnly,
  normaliseSource,
  sharedFiles,
  styleEntries,
} from '../check-android-ui-isolation.mjs';

const beta = { target: 'android/beta' };
const change = (status, file, head, fork, extra = {}) => ({ status, file, head, fork, ...extra });

test('recognises files only Android loads', () => {
  for (const file of [
    'src/screens/HomeScreen.android.tsx',
    'src/lib/__tests__/pipeline.android.test.ts',
    'src/android/Tabs.tsx',
    'modules/android-dictation/android/src/main/Bubble.kt',
    'modules/background-uploader/android/build.gradle',
    'app/android-setup.tsx',
    'app-android/(tabs)/(notes)/index.tsx',
    'app/(tabs)/(style)/index.tsx',
    'assets/android/adaptive-icon-foreground.png',
    'plugins/android-billing/withAndroidBilling.js',
    'scripts/android-build-check.mjs',
    'config/router-context.android.js',
  ]) {
    assert.equal(isAndroidOnly(file), true, file);
  }
  for (const file of [
    'src/screens/HomeScreen.tsx',
    'app/index.tsx',
    'src/lib/android.ts',
    'src/lib/androidCopy.ts',
    'plugins/keyboard-extension/withKeyboardExtension.js',
    'modules/background-uploader/ios/Uploader.swift',
    'config/router-context.ios.js',
  ]) {
    assert.equal(isAndroidOnly(file), false, file);
  }
});

test('into android/beta, a file iOS owns may only go back to its fork-point content', () => {
  assert.deepEqual(
    fileViolations(
      [
        change('M', 'src/store/useAuthStore.ts', 'restored', 'restored'),
        change('M', 'src/lib/utils.ts', 'edited', 'original'),
        change('D', 'src/lib/alerts.ts', null, 'original'),
        change('M', 'modules/live-activity/ios/Activity.swift', 'edited', 'original'),
        change('M', 'src/config/providerCatalog.json', 'edited', 'original'),
      ],
      beta,
    ).map((problem) => problem.split(':')[0]),
    [
      'modules/live-activity/ios/Activity.swift',
      'src/config/providerCatalog.json',
      'src/lib/alerts.ts',
      'src/lib/utils.ts',
    ],
  );
});

test('a file the fork point never had may be deleted, and edited only if Android owns it', () => {
  assert.deepEqual(
    fileViolations(
      [
        change('D', 'src/store/createAuthStore.ts', null, null),
        change('M', 'src/screens/HomeScreen.android.tsx', 'b', null),
        change('A', 'src/android/store/createAuthStore.ts', 'a', null),
      ],
      beta,
    ),
    [],
  );
});

test('new Android code may not land under a shared path', () => {
  assert.deepEqual(
    fileViolations([change('A', 'src/lib/androidCopy2.ts', 'a', null)], beta).map(
      (p) => p.split(':')[0],
    ),
    ['src/lib/androidCopy2.ts'],
  );
});

test('shared build files are left to the iOS fingerprint, not the content rule', () => {
  assert.deepEqual(
    fileViolations(
      [
        change('M', 'package.json', 'b', 'a'),
        change('M', 'app.base.json', 'b', 'a'),
        change('M', 'metro.config.js', 'b', 'a'),
        change('M', 'tailwind.config.js', 'b', 'a'),
      ],
      beta,
    ),
    [],
  );
});

test('a new patch may only touch Android parts or packages iOS does not link', () => {
  const patch = (file, patchTargets) => change('A', file, 'p', null, { patchTargets });
  assert.deepEqual(
    fileViolations(
      [
        patch('patches/react-native-screens+4.23.0.patch', [
          'node_modules/react-native-screens/android/src/main/java/Header.kt',
        ]),
        patch('patches/llama.rn+0.12.3.patch', ['node_modules/llama.rn/cpp/rn-completion.cpp']),
        patch('patches/@react-native+gradle-plugin+0.83.10.patch', [
          'node_modules/@react-native/gradle-plugin/settings.gradle.kts',
        ]),
        patch('patches/react-native-menu+2.0.0.patch', [
          'node_modules/@react-native-menu/menu/ios/MenuView.mm',
        ]),
      ],
      { ...beta, iosExcludedPackages: ['llama.rn'] },
    ).map((p) => p.split(':')[0]),
    ['patches/react-native-menu+2.0.0.patch'],
  );
});

test('a pull request stacked on another Android branch is Android work', () => {
  assert.deepEqual(
    fileViolations([change('M', 'src/lib/utils.ts', 'edited', 'original')], {
      target: 'chore/android-ios-isolation-guard',
    }).length,
    1,
  );
  assert.deepEqual(
    fileViolations([change('A', 'src/android/x.ts', 'a', null)], { target: 'feat/some-split' }),
    [],
  );
});

test('docs change freely', () => {
  assert.deepEqual(
    fileViolations(
      [change('M', 'README.md', 'b', 'a'), change('A', 'docs/android-notes.md', 'a', null)],
      beta,
    ),
    [],
  );
});

test('into main, Android-only files never change', () => {
  assert.deepEqual(
    fileViolations(
      [
        change('M', 'src/screens/HomeScreen.tsx', 'b', 'a'),
        change('M', 'src/android/Tabs.tsx', 'b', null),
      ],
      { target: 'main' },
    ).map((p) => p.split(':')[0]),
    ['src/android/Tabs.tsx'],
  );
});

test('source paths are rooted at the project and NativeWind is read through its iOS alias', () => {
  assert.equal(normaliseSource('/src/lib/utils.ts'), 'src/lib/utils.ts');
  assert.equal(normaliseSource('\u0000polyfill:external-require'), null);
  assert.equal(
    normaliseSource(
      '/node_modules/nativewind-ios/node_modules/react-native-css-interop/dist/index.js',
    ),
    'node_modules/react-native-css-interop/dist/index.js',
  );
  assert.equal(
    normaliseSource('/node_modules/nativewind-ios/dist/index.js'),
    'node_modules/nativewind/dist/index.js',
  );
});

test('style data ignores position shifts but sees new rules, changed rules and reordering', () => {
  const bundle = (rules) =>
    `x;(0, _styles.injectData)({"$compiled":true,rem:14,rules:{${rules}}});y(")");`;
  const base = styleEntries(
    extractStyleData(
      bundle(
        'flex:{n:[{s:[1,1],d:[[{display:"flex"}]]}]},hidden:{n:[{s:[2,1],d:[[{display:"none"}]]}]}',
      ),
    ),
  );
  const shifted = styleEntries(
    extractStyleData(
      bundle(
        'flex:{n:[{s:[1,1],d:[[{display:"flex"}]]}]},grid:{n:[{s:[2,1],d:[]}]},hidden:{n:[{s:[3,1],d:[[{display:"none"}]]}]}',
      ),
    ),
  );
  const changed = styleEntries(
    extractStyleData(
      bundle(
        'flex:{n:[{s:[1,1],d:[[{display:"none"}]]}]},hidden:{n:[{s:[2,1],d:[[{display:"none"}]]}]}',
      ),
    ),
  );
  assert.equal(shifted['style:0:rule:hidden'], base['style:0:rule:hidden']);
  assert.deepEqual(diffFingerprints(shifted, base), ['style:0:order', 'style:0:rule:grid']);
  assert.deepEqual(diffFingerprints(changed, base), ['style:0:rule:flex']);
});

test('the fingerprint skips the isolation plumbing and records versions, config and modules', () => {
  const sources = new Map([
    ['index.ts', { content: 'import "expo-router/entry";' }],
    ['config/router-context.ios.js', { content: 'ctx' }],
    ['src/lib/utils.ts', { content: 'export const a = 1;' }],
  ]);
  const fingerprint = buildFingerprint({
    sources,
    versions: { 'node_modules/nativewind': '4.2.1' },
    styles: {},
    config: { production: { infoPlist: { UIBackgroundModes: ['audio'] } } },
  });
  assert.deepEqual(Object.keys(fingerprint), [
    'config:production:infoPlist.UIBackgroundModes',
    'module:src/lib/utils.ts',
    'package:node_modules/nativewind',
  ]);
});

test('shared files are app files both bundles contain', () => {
  const ios = new Map([
    ['src/lib/utils.ts', {}],
    ['src/screens/Home.tsx', {}],
    ['node_modules/react/index.js', {}],
  ]);
  const android = new Map([
    ['src/lib/utils.ts', {}],
    ['src/android/Home.tsx', {}],
    ['node_modules/react/index.js', {}],
  ]);
  assert.deepEqual(sharedFiles(ios, android), ['src/lib/utils.ts']);
});
