const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

global.React = React;

const originalLoad = Module._load;
Module._load = function loadWithTranslationStub(request, parent, isMain) {
  if (request === "react-i18next") {
    return { useTranslation: () => ({ t: (key) => key }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ActivationModeSelector } = require("../../src/components/ui/ActivationModeSelector.tsx");
Module._load = originalLoad;

test("an unsupported Hold option stays explained while Tap remains usable", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ActivationModeSelector, {
      value: "tap",
      onChange: () => undefined,
      pushDisabledReason: "Choose a hotkey with a non-modifier key.",
    })
  );
  const buttons = markup.match(/<button[^>]*>/g);

  assert.equal(buttons.length, 2);
  assert.doesNotMatch(buttons[0], /disabled/);
  assert.match(buttons[1], /disabled/);
  assert.match(buttons[1], /title="Choose a hotkey with a non-modifier key\."/);
  assert.match(buttons[1], /aria-label="common\.hold: Choose a hotkey with a non-modifier key\."/);
});
