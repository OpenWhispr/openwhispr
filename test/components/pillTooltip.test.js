const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");

test("pointer-recovered hover reveals the tooltip without native mouseenter", async (t) => {
  const vite = await createRendererServer(t);
  const { PillTooltip } = await vite.ssrLoadModule("/components/dictation/PillTooltip.tsx");
  const render = (props) =>
    renderToStaticMarkup(
      createElement(PillTooltip, {
        content: "Press to dictate",
        children: createElement("button", null, "Pill"),
        ...props,
      })
    );
  assert.match(render({ open: true }), /Press to dictate/);
  assert.doesNotMatch(render({ open: false }), /Press to dictate/);
  assert.doesNotMatch(render({ open: true, disabled: true }), /Press to dictate/);
  assert.doesNotMatch(render({}), /Press to dictate/);
});
