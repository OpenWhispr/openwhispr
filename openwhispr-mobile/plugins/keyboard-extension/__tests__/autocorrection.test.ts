import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const mobile = path.resolve(__dirname, '../../..');
const ios = path.join(__dirname, '../ios');

// Exercise the production Swift rules, not a JavaScript reimplementation. Linux CI without
// Swift explicitly skips this test; run the same script on macOS before device testing.
const hasSwift = spawnSync('swiftc', ['--version']).status === 0;
(hasSwift ? test : test.skip)('production Swift decision, invalidation and undo tests', () => {
  const result = spawnSync('sh', ['scripts/test-keyboard-autocorrection.sh'], {
    cwd: mobile,
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('checks passed');
});

test('autocorrection is on unless the app switches it off', () => {
  const controller = fs.readFileSync(path.join(ios, 'KeyboardViewController.swift'), 'utf8');
  // Only the app's explicit "0" turns it off; an unreadable App Group keeps it on.
  expect(controller).toContain('"keyboard_autocorrection_enabled"');
  expect(controller).toContain('.string(forKey: autocorrectionSwitchKey) != "0"');
  expect(controller).toContain('guard context.isSafe, autocorrectionSwitchedOn() else');
  expect(controller).not.toContain('spaceButton.addGestureRecognizer');
  // Default-on must not bypass host restrictions or move correction into all insertions.
  expect(controller).toContain('allowed: ordinaryField && !fieldHidesItsText');
  expect(controller).toContain('proxy.autocorrectionType != .no');
  expect(controller).toContain('!applyDoubleSpacePeriod() && !applyManualSpaceCorrection()');
});

test('the selected dictionaries are all consulted', () => {
  const rules = fs.readFileSync(path.join(ios, 'KeyboardAutocorrection.swift'), 'utf8');
  const provider = fs.readFileSync(path.join(ios, 'TextCheckerCorrectionProvider.swift'), 'utf8');
  expect(rules).toContain('dictionaries: ["de_DE", "de-DE", "de"]');
  expect(rules).toContain('dictionaries: ["en_US", "en-US", "en_GB", "en-GB", "en"]');
  // A word any selected dictionary knows is never replaced.
  expect(provider).toContain(
    'dictionaries.allSatisfy({ misspelledRange(of: word, in: $0) == range })',
  );
  const controller = fs.readFileSync(path.join(ios, 'KeyboardViewController.swift'), 'utf8');
  expect(controller).toContain('"keyboard_autocorrection_languages"');
  expect(controller).toContain('KeyboardHandoffProvider.shared.autocorrectionLanguageSetting()');
  expect(controller).toContain('KeyboardHandoffProvider.shared.isAutocorrectionSwitchedOn()');
});

test("the app offers exactly the keyboard's languages, with the same default and cap", () => {
  const rules = fs.readFileSync(path.join(ios, 'KeyboardAutocorrection.swift'), 'utf8');
  const swiftCodes = [...rules.matchAll(/Self\(code: "([a-z-]+)"/g)].map((match) => match[1]);
  const {
    KEYBOARD_AUTOCORRECTION_LANGUAGES,
    DEFAULT_KEYBOARD_AUTOCORRECTION_LANGUAGES,
    MAX_KEYBOARD_AUTOCORRECTION_LANGUAGES,
  } = require('../../../src/lib/keyboardAutocorrection');
  expect(KEYBOARD_AUTOCORRECTION_LANGUAGES.map((l: { code: string }) => l.code)).toEqual(
    swiftCodes,
  );
  expect(DEFAULT_KEYBOARD_AUTOCORRECTION_LANGUAGES).toEqual(['de', 'en']);
  expect(rules).toContain('static let defaultSelection = [german, english]');
  expect(rules).toContain(`static let maxSelected = ${MAX_KEYBOARD_AUTOCORRECTION_LANGUAGES}`);
});
