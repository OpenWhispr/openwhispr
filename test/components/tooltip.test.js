const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { createElement } = React;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

const event = (type, extra = {}) => ({
  type,
  bubbles: true,
  ...extra,
  preventDefault() {},
  stopPropagation() {},
});

async function renderTooltip(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  // The tooltip measures its trigger and itself; this DOM has no layout.
  Object.getPrototypeOf(container).getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 10,
    bottom: 10,
    width: 10,
    height: 10,
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tooltip-test-",
    mockModules: {},
  });
  const { Tooltip } = await vite.ssrLoadModule("/components/ui/tooltip.tsx");
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      createElement(Tooltip, { content: "Hide for me" }, createElement("button", null, "x"))
    )
  );
  const button = findElement(container, (node) => node.tagName === "BUTTON");
  const shown = () => container.textContent.includes("Hide for me");
  const focusWith = (keyboard) =>
    React.act(async () => {
      button.matches = (selector) => selector === ":focus-visible" && keyboard;
      button.dispatchEvent(event("focusin"));
    });
  const dispatch = (type, extra) => React.act(async () => button.dispatchEvent(event(type, extra)));
  return { shown, focusWith, dispatch };
}

test("keyboard focus shows the tooltip; blur and Escape hide it", async (t) => {
  const { shown, focusWith, dispatch } = await renderTooltip(t);
  assert.equal(shown(), false);

  await focusWith(true);
  assert.equal(shown(), true);
  await dispatch("focusout", { relatedTarget: null });
  assert.equal(shown(), false);

  await focusWith(true);
  await dispatch("keydown", { key: "Escape" });
  assert.equal(shown(), false);
});

test("focus handed back without the keyboard (a closing dialog or menu) shows nothing", async (t) => {
  const { shown, focusWith } = await renderTooltip(t);
  await focusWith(false);
  assert.equal(shown(), false);
});
