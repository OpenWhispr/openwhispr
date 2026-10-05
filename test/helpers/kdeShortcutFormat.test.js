const test = require("node:test");
const assert = require("node:assert/strict");

const KDEShortcutManager = require("../../src/helpers/kdeShortcut");

const QT_CONTROL = 0x04000000;
const QT_ALT = 0x08000000;
const QT_KEY_F8 = 0x01000037;
const QT_KEY_COMMA = 0x2c;
const QT_KEY_PERIOD = 0x2e;
const QT_KEY_SLASH = 0x2f;
const QT_KEY_MINUS = 0x2d;
const QT_KEY_PLUS = 0x2b;

test("letter and function-key shortcuts still convert", () => {
  assert.equal(KDEShortcutManager.convertToQtKeyCode("F8"), QT_KEY_F8);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Control+F8"), QT_CONTROL | QT_KEY_F8);
  assert.equal(KDEShortcutManager.convertToQtKeyCode("Alt+R"), QT_ALT | 0x52);
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
