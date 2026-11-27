const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

global.React = React;

const originalLoad = Module._load;
Module._load = function loadWithTranslationStub(request, parent, isMain) {
  if (request === "react-i18next") {
    return {
      useTranslation: () => ({
        t: (key, values) => (values?.hotkey ? `${key} ${values.hotkey}` : key),
      }),
    };
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

test("the dictation picker exposes the combined mode and displays the bound shortcut", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ActivationModeSelector, {
      value: "push-double-tap",
      onChange: () => undefined,
      doubleTapHotkey: "Ctrl + Space",
    })
  );
  const buttons = markup.match(/<button[^>]*>/g);

  assert.equal(buttons.length, 3);
  assert.match(buttons[2], /aria-pressed="true"/);
  assert.match(markup, /holdWithDoubleTap/);
  assert.match(markup, /doubleTapHint.*<bdi dir="ltr">Ctrl \+ Space<\/bdi>/);
});

test("a backend without release events disables both Hold choices", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ActivationModeSelector, {
      value: "tap",
      onChange: () => undefined,
      doubleTapHotkey: "Ctrl + Space",
      pushDisabledReason: "Key release unavailable",
    })
  );
  const buttons = markup.match(/<button[^>]*>/g);

  assert.equal(buttons.length, 3);
  assert.doesNotMatch(buttons[0], /disabled/);
  assert.match(buttons[1], /disabled/);
  assert.match(buttons[2], /disabled/);
  assert.doesNotMatch(markup, /doubleTapHint/);
});

test("an unsupported secondary binding disables only the combined option", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ActivationModeSelector, {
      value: "push-double-tap",
      onChange: () => undefined,
      doubleTapHotkey: "Globe/Fn, F8",
      doubleTapDisabledReason: "F8 cannot report its release",
    })
  );
  const buttons = markup.match(/<button[^>]*>/g);

  assert.equal(buttons.length, 3);
  assert.doesNotMatch(buttons[0], /disabled/);
  assert.doesNotMatch(buttons[1], /disabled/);
  assert.match(buttons[2], /disabled.*title="F8 cannot report its release"/);
  assert.match(markup, />F8 cannot report its release<\/p>/);
  assert.doesNotMatch(markup, /doubleTapHint/);
});
