const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Stand-in DOM nodes on one page: a node contains itself and every node under it.
function fakePage() {
  const page = { activeElement: null };
  page.node = (parent = null) => {
    const self = {
      parent,
      ownerDocument: page,
      contains: (other) => {
        for (let node = other; node; node = node.parent) {
          if (node === self) return true;
        }
        return false;
      },
    };
    return self;
  };
  return page;
}

async function mountHold(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-focus-hold-" });
  const { useFocusHold } = await vite.ssrLoadModule("/hooks/useFocusHold.ts");
  let hold;
  function Harness() {
    hold = useFocusHold();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return {
    held: () => hold.held,
    focus: () => React.act(async () => hold.onFocus()),
    // currentTarget: the element the hold is bound to; relatedTarget: where focus went.
    blur: (currentTarget, relatedTarget = null) =>
      React.act(async () => hold.onBlur({ currentTarget, relatedTarget })),
  };
}

test("a focus hold lasts until focus really leaves, a window switch included", async (t) => {
  const hold = await mountHold(t);
  const page = fakePage();
  const field = page.node();
  assert.equal(hold.held(), false);
  await hold.focus();
  assert.equal(hold.held(), true);
  page.activeElement = field; // the window lost focus, but the field is still the page's focus
  await hold.blur(field);
  assert.equal(hold.held(), true, "switching to another app keeps the hold");
  page.activeElement = null;
  await hold.blur(field);
  assert.equal(hold.held(), false);
});

test("focus moving to another field inside the held element keeps the hold", async (t) => {
  const hold = await mountHold(t);
  const page = fakePage();
  const fields = page.node();
  const next = page.node(fields);
  await hold.focus();
  await hold.blur(fields, next);
  assert.equal(hold.held(), true, "focus moved to another of its fields");
  page.activeElement = next; // a window switch with a field inside it focused
  await hold.blur(fields);
  assert.equal(hold.held(), true, "switching apps keeps it");
  page.activeElement = null;
  await hold.blur(fields, page.node());
  assert.equal(hold.held(), false, "focus left its fields");
});
