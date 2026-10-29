const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");

test("Toggle exposes an accessible switch name and state", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-toggle-accessibility-",
  });
  const { Toggle } = await vite.ssrLoadModule("/components/ui/toggle.tsx");

  const markup = renderToStaticMarkup(
    React.createElement(Toggle, {
      checked: true,
      onChange() {},
      ariaLabel: "Enable Escape to cancel",
    })
  );

  assert.match(markup, /type="button"/);
  assert.match(markup, /role="switch"/);
  assert.match(markup, /aria-checked="true"/);
  assert.match(markup, /aria-label="Enable Escape to cancel"/);

  await t.test("unchecked switches keep the optional label and toggle on", () => {
    const changes = [];
    const button = Toggle({ checked: false, onChange: (checked) => changes.push(checked) });
    const markup = renderToStaticMarkup(button);

    assert.match(markup, /aria-checked="false"/);
    assert.doesNotMatch(markup, /aria-label=/);
    button.props.onClick();
    assert.deepEqual(changes, [true]);
  });

  await t.test("checked switches toggle off", () => {
    const changes = [];
    const button = Toggle({ checked: true, onChange: (checked) => changes.push(checked) });

    button.props.onClick();
    assert.deepEqual(changes, [false]);
  });

  await t.test("disabled switches keep their state without firing onChange", () => {
    for (const checked of [true, false]) {
      const button = Toggle({
        checked,
        disabled: true,
        ariaLabel: "Disabled setting",
        onChange: () => assert.fail("a disabled toggle must not change"),
      });
      const markup = renderToStaticMarkup(button);

      assert.match(markup, /disabled=""/);
      assert.match(markup, new RegExp(`aria-checked="${checked}"`));
      assert.match(markup, /aria-label="Disabled setting"/);
      button.props.onClick();
    }
  });
});
