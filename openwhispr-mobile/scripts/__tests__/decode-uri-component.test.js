const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const lockfile = require('../../package-lock.json');

const decoderPaths = Object.keys(lockfile.packages).filter((entry) =>
  entry.endsWith('node_modules/decode-uri-component'),
);
assert.ok(decoderPaths.length > 0, 'Expected the router URI decoder in the lockfile');

for (const decoderPath of decoderPaths) {
  const resolved = path.resolve(__dirname, '../..', decoderPath);
  const decode = require(resolved);
  test(`${decoderPath}: preserves query-string's CommonJS and plus-sign API`, () => {
    assert.equal(decode('hello+world%21'), 'hello world!');
    assert.equal(decode('%C3%A4%F0%9F%98%80'), 'ä😀');
    assert.equal(decode('%FE%FF'), '\uFFFD\uFFFD');
    assert.equal(decode('%C2'), '\uFFFD');
    assert.equal(decode('%G0%41'), '%G0A');
    assert.equal(decode('%2541%FF'), '%41%FF');
    assert.throws(() => decode(null), TypeError);
  });
  test(`${decoderPath}: malformed long runs terminate without recursion or rescanning`, () => {
    // A subprocess timeout contains a regression instead of hanging the CI worker.
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict');
      const decode = require(${JSON.stringify(resolved)});
      assert.equal(decode('%FF'.repeat(20000)), '%FF'.repeat(20000));
      const mixed = Array.from({length: 5000}, (_, i) => '%41'.repeat(i % 7 + 1) + '%FF').join('');
      assert.equal(decode(mixed), mixed.replace(/%41/g, 'A'));
    `,
      ],
      { timeout: 10000, encoding: 'utf8' },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}

test('Expo Router query-string integration still parses form parameters', () => {
  const queryString = require('query-string');
  assert.deepEqual(
    { ...queryString.parse('name=hello+world&unicode=%C3%A4&bad=%FF%41') },
    {
      name: 'hello world',
      unicode: 'ä',
      bad: '%FFA',
    },
  );
});
