const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const hotkeys = require("../../src/utils/hotkeys.ts");

const filename = path.join(__dirname, "../../src/components/SettingsPage.tsx");
const source = ts.createSourceFile(
  filename,
  fs.readFileSync(filename, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

function findExpression(predicate, from = source) {
  if (predicate(from)) return from;
  return ts.forEachChild(from, (child) => findExpression(predicate, child));
}

function jsxAttribute(node, name) {
  return node.attributes.properties.find((attribute) => attribute.name?.getText(source) === name)
    ?.initializer?.expression;
}

const modeInfo = findExpression(
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "useHotkeyModeInfo" &&
    node.arguments[0]?.text === "settings"
);
const activationPicker = findExpression(
  (node) =>
    ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "ActivationModeSelector"
);
const shortcutEditor = findExpression(
  (node) =>
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(source) === "HotkeyListInput" &&
    jsxAttribute(node, "validate")?.getText(source) === "validateDictationHotkey"
);

function evaluate(expression, state = {}) {
  assert.ok(expression);
  return vm.runInNewContext(expression.getText(source), {
    ...hotkeys,
    activeDictationKey: "GLOBE",
    dictationKey: "GLOBE,F8",
    effectiveDefaultHotkey: "GLOBE",
    isUsingNativeShortcut: false,
    useHotkeyModeInfo: (_scope, candidate) => candidate,
    ...state,
  });
}

test("the Settings activation picker checks registered shortcuts after a partial restore", () => {
  assert.equal(evaluate(modeInfo), "GLOBE");
  assert.equal(evaluate(modeInfo, { activeDictationKey: null }), undefined);
});

test("the Settings activation hint names only the registered shortcuts", () => {
  const hint = jsxAttribute(activationPicker, "doubleTapHotkey");
  assert.equal(evaluate(hint), "Globe/Fn");
  assert.equal(
    evaluate(hint, {
      activeDictationKey: "Control+Space",
      isUsingNativeShortcut: true,
    }),
    "Ctrl+Space"
  );
});

test("the dictation shortcut editor keeps the saved list after a partial restore", () => {
  assert.equal(evaluate(jsxAttribute(shortcutEditor, "value")), "GLOBE,F8");
});
