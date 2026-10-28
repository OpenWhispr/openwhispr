const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

function click(element) {
  element.dispatchEvent({
    type: "click",
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  });
}

async function renderBreadcrumb(t, props) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-breadcrumb-test-" });
  const { Breadcrumb } = await vite.ssrLoadModule("/components/ui/Breadcrumb.tsx");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Breadcrumb, props)));
  return container;
}

test("the parent is a button that goes back and the current page is marked", async (t) => {
  let backs = 0;
  const container = await renderBreadcrumb(t, {
    label: "Breadcrumb",
    items: [{ label: "Skills", onSelect: () => backs++ }, { label: "Upload skill" }],
  });

  const nav = findElement(container, (node) => node.tagName === "NAV");
  assert.equal(nav.getAttribute("aria-label"), "Breadcrumb");
  const parent = findElement(nav, (node) => node.tagName === "BUTTON");
  assert.equal(parent.textContent, "Skills");
  const current = findElement(nav, (node) => node.getAttribute("aria-current") === "page");
  assert.deepEqual([current.tagName, current.textContent], ["SPAN", "Upload skill"]);
  assert.equal(
    findElement(nav, (node) => node.tagName === "BUTTON" && node.textContent === "Upload skill"),
    null
  );

  await React.act(async () => click(parent));
  assert.equal(backs, 1);
});

test("the separator turns in right-to-left layouts", async (t) => {
  const container = await renderBreadcrumb(t, {
    label: "Breadcrumb",
    items: [{ label: "Skills", onSelect: () => {} }, { label: "Manage skills" }],
  });

  const separator = findElement(container, (node) => node.getAttribute("aria-hidden") === "true");
  assert.equal(separator.tagName, "LI");
  const chevron = findElement(separator, (node) => node.tagName === "SVG");
  assert.match(chevron.getAttribute("class"), /(^|\s)rtl:rotate-180(\s|$)/);
});
