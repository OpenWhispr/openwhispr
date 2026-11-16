const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");
const { dispatch } = require("../lib/skillsHarness");

async function renderDropZone(t, props) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-drop-zone-test-" });
  const { DropZone } = await vite.ssrLoadModule("/components/ui/DropZone.tsx");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(DropZone, props)));
  return findElement(container, (node) => node.getAttribute("role") === "button");
}

test("it reports dropped files and browses on click, Enter and Space", async (t) => {
  const dropped = [];
  let browses = 0;
  const zone = await renderDropZone(t, {
    label: "Drag skill files here, or browse",
    activeLabel: "Drop to add",
    hint: "You can add several at once.",
    onFiles: (files) => dropped.push(files.map((file) => file.name)),
    onBrowse: () => browses++,
  });
  assert.deepEqual(
    [zone.getAttribute("aria-label"), zone.getAttribute("tabindex")],
    ["Drag skill files here, or browse", "0"]
  );
  assert.match(zone.textContent, /You can add several at once\./);

  await React.act(async () => dispatch(zone, "dragover"));
  assert.match(zone.textContent, /Drop to add/);
  assert.doesNotMatch(zone.textContent, /several at once/);
  const files = [{ name: "a.md" }, { name: "b.skill" }];
  await React.act(async () => dispatch(zone, "drop", { dataTransfer: { files } }));
  // An empty drop (a dragged selection of text) reports nothing
  await React.act(async () => dispatch(zone, "drop", { dataTransfer: { files: [] } }));
  assert.deepEqual(dropped, [["a.md", "b.skill"]]);
  assert.match(zone.textContent, /Drag skill files here, or browse/);

  await React.act(async () => dispatch(zone, "click"));
  await React.act(async () => dispatch(zone, "keydown", { key: "Enter" }));
  await React.act(async () => dispatch(zone, "keydown", { key: " " }));
  await React.act(async () => dispatch(zone, "keydown", { key: "Tab" }));
  assert.equal(browses, 3);
});
