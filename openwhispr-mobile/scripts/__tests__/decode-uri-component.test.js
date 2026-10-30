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
  test(`${decoderPath}: malformed UTF-8 and decoded percent signs retain single-pass semantics`, () => {
    // Boundary cases from upstream 0.5.1; malformed bytes stay literal rather than
    // becoming overlong characters, surrogates, or code points above U+10FFFF.
    const cases = {
      '%C0%AF': '%C0%AF',
      '%C1%BF': '%C1%BF',
      '%E0%80%80': '%E0%80%80',
      '%ED%A0%80': '%ED%A0%80',
      '%F0%80%80%80': '%F0%80%80%80',
      '%F4%90%80%80': '%F4%90%80%80',
      '%F5%80%80%80': '%F5%80%80%80',
      '%F0%9F%98': '%F0%9F%98',
      '%F0%9F%41': '%F0%9FA',
      '%E2%41%AC': '%E2A%AC',
      '%C3%41': '%C3A',
      '%80%BF': '%80%BF',
      '%C2%C2%B5': '\uFFFDµ',
      '%c2': '%c2',
      '%FE%FF%41%FF%FE': '\uFFFD\uFFFDA\uFFFD\uFFFD',
      '%fe%ff': '%fe%ff',
      '%ED%9F%BF%F4%8F%BF%BF': '\uD7FF\u{10FFFF}',
      '%c3%a5%ab': 'å%ab',
      '%25C2%zz': '%C2%zz',
      '%25%41%zz': '%A%zz',
      '%84%D7%25%88%90': '%84%D7%%88%90',
      '%2B+%FF': '+ %FF',
    };
    for (const [input, expected] of Object.entries(cases)) {
      assert.equal(decode(input), expected, input);
    }
  });
  test(`${decoderPath}: published distinct-run quadratic payload finishes within the subprocess deadline`, () => {
    // Exact GHSA-qr28-fpjm-wq7f payload: repeated identical runs do NOT exercise
    // the O(K*L) replacement loop left in 0.5.0 after its recursion fix.
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict');
      const decode = require(${JSON.stringify(resolved)});
      let payload = '';
      let expected = '';
      for (let i = 0; i < 32000; i++) {
        const high = Math.floor(i / 256).toString(16).padStart(2, '0');
        const low = (i % 256).toString(16).padStart(2, '0');
        const run = '%' + high + '%' + low;
        payload += run + 'x';
        // All high bytes are ASCII; low bytes >= 0x80 remain literal.
        expected += String.fromCharCode(Math.floor(i / 256));
        expected += i % 256 < 128 ? String.fromCharCode(i % 256) : '%' + low;
        expected += 'x';
      }
      payload += '%zz';
      assert.equal(decode(payload), expected + '%zz');
    `,
      ],
      { timeout: 5000, encoding: 'utf8' },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
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
