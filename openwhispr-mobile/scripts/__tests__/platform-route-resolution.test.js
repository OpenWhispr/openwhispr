const assert = require('node:assert/strict');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { getRoutes } = require('expo-router/build/getRoutesCore');

const app = path.resolve(__dirname, '../../app');
const context = () => ({ default: () => null });
context.keys = () =>
  readdirSync(app, { recursive: true })
    .filter((file) => /\.[jt]sx?$/.test(file) && !file.includes('__tests__'))
    .map((file) => `./${file}`);

// Exercise the installed Router's actual selection without loading native app
// modules or executing startup side effects (including local SQLite migrations).
for (const platform of ['ios', 'android']) {
  test(`${platform} selects its platform layout and redirect entrypoints`, () => {
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
