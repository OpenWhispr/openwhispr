const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');
const { getRoutes } = require('expo-router/build/getRoutesCore');

const app = path.resolve(__dirname, '../../app');
const currentKeys = readdirSync(app, { recursive: true })
  .filter((file) => /\.[jt]sx?$/.test(file) && !file.includes('__tests__'))
  .map((file) => `./${file}`);
let iosContextRegex;
// Read the same static require.context filter Metro compiles, without loading routes.
vm.runInNewContext(
  readFileSync(path.resolve(__dirname, '../../config/router-context.ios.js'), 'utf8').replace(
    'export const ctx',
    'const ctx',
  ),
  {
    process: { env: {} },
    require: {
      context: (_root, _recursive, regex) => {
        iosContextRegex = regex;
      },
    },
  },
);
const iosKeys = currentKeys.filter((key) => iosContextRegex.test(key));
test('iOS route context retains the incorporated upstream route entries', () => {
  assert.deepEqual(iosKeys.sort(), require('./fixtures/upstream-ios-route-entries.json'));
});

// Exercise the installed Router's actual selection without loading native app
// modules or executing startup side effects (including local SQLite migrations).
for (const platform of ['ios', 'android']) {
  test(`${platform} selects its platform layout and redirect entrypoints`, () => {
    const context = () => ({ default: () => null });
    context.keys = () => (platform === 'ios' ? iosKeys : currentKeys);
    const routes = getRoutes(context, {
      platform,
      ignoreEntryPoints: true,
      skipGenerated: true,
    });
    const suffix = platform === 'android' ? '.android' : '';
    assert.equal(
      routes.children.find((route) => route.route === '(account)').contextKey,
      `./(account)/_layout${suffix}.tsx`,
    );
    assert.equal(
      routes.children
        .find((route) => route.route === '(tabs)')
        .children.find((route) => route.route === '(notes)').contextKey,
      `./(tabs)/(notes)/_layout${suffix}.tsx`,
    );
    assert.equal(routes.contextKey, `./_layout${suffix}.tsx`);
    assert.equal(
      routes.children.find((route) => route.route === '(tabs)').contextKey,
      `./(tabs)/_layout${suffix}.tsx`,
    );
    assert.equal(
      routes.children.find((route) => route.route === 'index').contextKey,
      `./index${suffix}.tsx`,
    );
    assert.equal(
      routes.children.find((route) => route.route === 'auth').contextKey,
      `./auth${suffix}.tsx`,
    );
  });
}
