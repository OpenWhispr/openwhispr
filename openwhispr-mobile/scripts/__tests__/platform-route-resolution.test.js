const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');
const { getRoutes } = require('expo-router/build/getRoutesCore');

// iOS routes live in app/, Android's in app-android/. Each platform's route context reads only
// its own tree.
function routeKeys(dir) {
  return readdirSync(path.resolve(__dirname, '../..', dir), { recursive: true })
    .filter((file) => /\.[jt]sx?$/.test(file) && !file.includes('__tests__'))
    .map((file) => `./${file}`)
    .sort();
}

// Read the static require.context call Metro compiles, without loading routes.
function readContext(file) {
  let call;
  vm.runInNewContext(
    readFileSync(path.resolve(__dirname, '../../config', file), 'utf8').replace(
      'export const ctx',
      'const ctx',
    ),
    {
      process: { env: {} },
      require: {
        context: (root, _recursive, regex) => {
          call = { root, regex };
        },
      },
    },
  );
  return call;
}

const iosKeys = routeKeys('app').filter((key) => readContext('router-context.ios.js').regex.test(key));
const android = readContext('router-context.android.js');
const androidKeys = routeKeys('app-android').filter((key) => android.regex.test(key));

test('iOS route context retains the incorporated upstream route entries', () => {
  assert.deepEqual(iosKeys, require('./fixtures/upstream-ios-route-entries.json'));
});

test('app/ holds no Android route and app-android/ no platform-suffixed one', () => {
  assert.deepEqual(
    routeKeys('app').filter((key) => /\.android\.|\/android-|\(style\)/.test(key)),
    [],
  );
  assert.deepEqual(
    androidKeys.filter((key) => /\.(?:ios|android|native|web)\.[jt]sx?$/.test(key)),
    [],
  );
  assert.equal(android.root, '../app-android');
});

const layoutKeys = (keys, platform) => {
  const context = () => ({ default: () => null });
  context.keys = () => keys;
  const routes = getRoutes(context, { platform, ignoreEntryPoints: true, skipGenerated: true });
  const child = (node, name) => node.children.find((route) => route.route === name);
  return [
    routes.contextKey,
    child(routes, '(account)').contextKey,
    child(routes, '(tabs)').contextKey,
    child(child(routes, '(tabs)'), '(notes)').contextKey,
    child(routes, 'index').contextKey,
    child(routes, 'auth').contextKey,
  ];
};

// Exercise the installed Router's actual selection without loading native app
// modules or executing startup side effects (including local SQLite migrations).
test('each platform builds its route tree from its own files', () => {
  const expected = [
    './_layout.tsx',
    './(account)/_layout.tsx',
    './(tabs)/_layout.tsx',
    './(tabs)/(notes)/_layout.tsx',
    './index.tsx',
    './auth.tsx',
  ];
  assert.deepEqual(layoutKeys(iosKeys, 'ios'), expected);
  assert.deepEqual(layoutKeys(androidKeys, 'android'), expected);
});

test('Android keeps the routes it had, without the iOS-only ones', () => {
  for (const key of [
    './(account)/device-check.tsx',
    './(account)/ai-workflow.tsx',
    './(tabs)/(notes)/import-audio.tsx',
    './(tabs)/(style)/index.tsx',
    './android-setup.tsx',
    './+native-intent.tsx',
  ]) {
    assert.ok(androidKeys.includes(key), key);
  }
  for (const key of [
    './(tabs)/(chat)/_layout.tsx',
    './keyboard-dictation.tsx',
    './(account)/model-download.tsx',
    './(account)/dictation-agent.tsx',
  ]) {
    assert.ok(!androidKeys.includes(key), key);
  }
});
