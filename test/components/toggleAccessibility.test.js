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
      "aria-label": "Enable Escape to cancel",
    })
  );

  assert.match(markup, /type="button"/);
  assert.match(markup, /role="switch"/);
  assert.match(markup, /aria-checked="true"/);
  assert.match(markup, /aria-label="Enable Escape to cancel"/);
});
