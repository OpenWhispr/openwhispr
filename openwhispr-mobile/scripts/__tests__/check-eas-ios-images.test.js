const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ALLOWED_IOS_IMAGES, findIosImageProblems } = require('../check-eas-ios-images');

const ALLOWED = ALLOWED_IOS_IMAGES[0];

test('the checked-in eas.json pins every profile to an allowed image', () => {
  const easConfig = JSON.parse(readFileSync(path.resolve(__dirname, '../../eas.json'), 'utf8'));
  assert.deepEqual(findIosImageProblems(easConfig), []);
});

test('a profile without ios.image fails', () => {
  const problems = findIosImageProblems({
    build: { production: { channel: 'production' }, preview: { ios: { image: ALLOWED } } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"production" has no ios\.image/);
});

test('"latest" fails', () => {
  const problems = findIosImageProblems({ build: { production: { ios: { image: 'latest' } } } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"latest"/);
});

test('an image outside the allowlist fails', () => {
  const problems = findIosImageProblems({
    build: { production: { ios: { image: 'macos-tahoe-26.6-xcode-27.1' } } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not in ALLOWED_IOS_IMAGES/);
});

test('a non-string image fails', () => {
  const problems = findIosImageProblems({ build: { production: { ios: { image: null } } } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not in ALLOWED_IOS_IMAGES/);
});

test('an image inherited through extends passes', () => {
  const problems = findIosImageProblems({
    build: {
      base: { ios: { image: ALLOWED } },
      production: { extends: 'base', channel: 'production' },
    },
  });
  assert.deepEqual(problems, []);
});

test('a profile overriding an inherited image is checked on its own value', () => {
  const problems = findIosImageProblems({
    build: {
      base: { ios: { image: ALLOWED } },
      production: { extends: 'base', ios: { image: 'latest' } },
    },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"production" uses ios\.image "latest"/);
});

test('extends without an image anywhere in the chain fails', () => {
  const problems = findIosImageProblems({
    build: { base: { channel: 'base' }, production: { extends: 'base' } },
  });
  assert.equal(problems.length, 2);
});

test('missing and circular extends fail instead of passing', () => {
  assert.match(
    findIosImageProblems({ build: { production: { extends: 'gone' } } })[0],
    /missing profile "gone"/,
  );
  const circular = findIosImageProblems({
    build: { a: { extends: 'b' }, b: { extends: 'a' } },
  });
  assert.equal(circular.length, 2);
  assert.match(circular[0], /extends itself/);
});

test('no build profiles fails', () => {
  assert.deepEqual(findIosImageProblems({}), ['eas.json has no build profiles']);
});
