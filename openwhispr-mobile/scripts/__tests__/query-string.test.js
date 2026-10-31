const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { test } = require('node:test');

// Exercise the dependency resolved by Expo Router, including its CommonJS boundary.
const routerRequire = createRequire(require.resolve('expo-router/package.json'));
const queryPath = routerRequire.resolve('query-string');
const query = routerRequire('query-string');

test('navigation query decoding preserves Unicode, plus, arrays and fragment behavior', () => {
  assert.deepEqual(
    { ...query.parse('q=Hello+%E2%9C%93&plus=%2B&tag=a&tag=b') },
    {
      plus: '+',
      q: 'Hello ✓',
      tag: ['a', 'b'],
    },
  );
  assert.deepEqual(
    query.parseUrl('https://example.invalid/?q=%25#hello+world', { parseFragmentIdentifier: true }),
    {
      url: 'https://example.invalid/',
      query: Object.assign(Object.create(null), { q: '%' }),
      fragmentIdentifier: 'hello world',
    },
  );
  assert.deepEqual(
    { ...query.parse('q=%E2%9C%93+text', { decode: false }) },
    { q: '%E2%9C%93+text' },
  );
  assert.deepEqual({ ...query.parse('q=%zz') }, { q: '%zz' });
});

test('malformed percent-encoded runs complete within a bounded subprocess', () => {
  // GHSA-qr28-fpjm-wq7f: distinct runs plus one malformed escape used to trigger
  // repeated full-input scans. Keep the vulnerable implementation out of this process.
  const script = `
    const query = require(process.argv[1]);
    const runs = Array.from({ length: 32000 }, (_, i) =>
      '%' + Math.floor(i / 256).toString(16).padStart(2, '0') +
      '%' + (i % 256).toString(16).padStart(2, '0') + 'x').join('');
    const result = query.parse('q=' + runs + '%zz');
    if (!result.q.endsWith('%zz')) throw new Error('Malformed suffix changed');
    process.stdout.write('complete');
  `;
  const result = spawnSync(process.execPath, ['-e', script, queryPath], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, 'URL decoding exceeded its bounded execution time');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'complete');
});
