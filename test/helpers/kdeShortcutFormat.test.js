const test = require("node:test");
const assert = require("node:assert/strict");

const KDEShortcutManager = require("../../src/helpers/kdeShortcut");

const QT_CONTROL = 0x04000000;
const QT_SHIFT = 0x02000000;
const QT_ALT = 0x08000000;
const QT_KEY_F8 = 0x01000037;
const QT_KEY_COMMA = 0x2c;
const QT_KEY_PERIOD = 0x2e;
const QT_KEY_SLASH = 0x2f;
const QT_KEY_MINUS = 0x2d;
const QT_KEY_PLUS = 0x2b;

test("letter and function-key shortcuts still convert", () => {
  assert.equal(KDEShortcutManager.convertToQtKeyCode("F1"), 0x01000030);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("F12"), 0x0100003b);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("F8"), QT_KEY_F8);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Control+F8"), QT_CONTROL | QT_KEY_F8);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Alt+R"), QT_ALT | 0x52);
});

for (const [key, qtKey] of [
  ["F13", 0x0100003c],
  ["F14", 0x0100003d],
  ["F15", 0x0100003e],
  ["F16", 0x0100003f],
  ["F17", 0x01000040],
  ["F18", 0x01000041],
  ["F19", 0x01000042],
  ["F20", 0x01000043],
  ["F21", 0x01000044],
  ["F22", 0x01000045],
  ["F23", 0x01000046],
  ["F24", 0x01000047],
]) {
  test(`${key} converts alone and with modifiers`, () => {
    assert.equal(KDEShortcutManager.convertToQtKeyCode(key), qtKey);
    assert.equal(KDEShortcutManager.convertToQtKeyCode(`Alt+${key}`), QT_ALT | qtKey);
    assert.equal(
      KDEShortcutManager.convertToQtKeyCode(`Control+Shift+${key}`),
      QT_CONTROL | QT_SHIFT | qtKey
    );
  });
}

test("extended function-key shortcuts normalize case and whitespace", () => {
  assert.equal(KDEShortcutManager.convertToQtKeyCode("f13"), 0x0100003c);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Control + f24"), QT_CONTROL | 0x01000047);
});

test("punctuation accelerators map to Qt key codes", () => {
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Control+,"), QT_CONTROL | QT_KEY_COMMA);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Alt+."), QT_ALT | QT_KEY_PERIOD);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Control+/"), QT_CONTROL | QT_KEY_SLASH);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Control+-"), QT_CONTROL | QT_KEY_MINUS);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Control+Plus"), QT_CONTROL | QT_KEY_PLUS);
});

test("unknown keys still return null", () => {
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Control+Unknown"), null);
});
