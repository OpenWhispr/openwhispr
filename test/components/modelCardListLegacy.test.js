const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const CURRENT = { value: "current", label: "Current" };
const RETIRED = { value: "retired", label: "Retired", legacy: true };
const KEPT = { value: "kept", label: "Kept", legacy: true };

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  return predicate(node) ? node : findElement(node.props?.children, predicate);
}

async function loadModelCardList(t) {
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-model-card-legacy-" });
  const module = await vite.ssrLoadModule("/components/ui/ModelCardList.tsx");
  // Runs the component with its hooks and returns the element tree it rendered;
  // the handlers in that tree stay callable after the unmount.
  const render = async (component, props) => {
    let tree;
    function Harness() {
      tree = component(props);
      return null;
    }
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    await React.act(async () => root.unmount());
    return tree;
  };
  return { ModelCardList: module.default, ModelCard: module.ModelCard, render };
}

const listedIds = (tree) => tree.props.children.map((card) => card.props.model.value);

test("a legacy model is listed only while it is the selection", async (t) => {
  const { ModelCardList, render } = await loadModelCardList(t);
  const models = [CURRENT, RETIRED, KEPT];
  const onModelSelect = () => {};

  assert.deepEqual(
    listedIds(await render(ModelCardList, { models, selectedModel: "kept", onModelSelect })),
    ["current", "kept"]
  );
  assert.deepEqual(
    listedIds(await render(ModelCardList, { models, selectedModel: "current", onModelSelect })),
    ["current"]
  );
});

test("a downloaded legacy local model stays listed so it can be deleted", async (t) => {
  const { ModelCardList, render } = await loadModelCardList(t);
  const tree = await render(ModelCardList, {
    models: [CURRENT, { ...RETIRED, isDownloaded: true }, KEPT],
    selectedModel: "current",
    onModelSelect: () => {},
    onDownload: () => {},
    onDelete: () => {},
  });
  assert.deepEqual(listedIds(tree), ["current", "retired"]);
});

test("a legacy card is marked, can't be picked, and offers no download", async (t) => {
  const { ModelCard, render } = await loadModelCardList(t);
  const selected = [];
  const deleted = [];
  const card = async (model, isSelected) =>
    render(ModelCard, {
      model,
      isSelected,
      onSelect: (id) => selected.push(id),
      onDownload: () => {},
      onDelete: (id) => deleted.push(id),
    });

  const downloaded = await card({ ...RETIRED, isDownloaded: true }, false);
  assert.equal(downloaded.props["aria-disabled"], true);
  assert.equal(downloaded.props.title, "models.legacyHint");
  assert.doesNotMatch(
    downloaded.props.className,
    /hover:/,
    "no hover lift on a card that can't be picked"
  );
  assert.ok(
    findElement(downloaded, (node) => node.props?.children === "models.legacy"),
    "a Legacy badge says why"
  );
  downloaded.props.onClick();
  assert.deepEqual(selected, []);
  const remove = findElement(
    downloaded,
    (node) => typeof node.props?.onClick === "function" && node.props.size === "icon"
  );
  remove.props.onClick({ stopPropagation() {} });
  assert.deepEqual(deleted, ["retired"]);

  const notDownloaded = await card(KEPT, true);
  assert.equal(
    findElement(notDownloaded, (node) => [node.props?.children].flat().includes("common.download")),
    null,
    "no Download button"
  );

  const current = await card({ ...CURRENT, isDownloaded: true }, false);
  assert.equal(current.props["aria-disabled"], undefined);
  assert.equal(current.props.title, undefined);
  current.props.onClick();
  assert.deepEqual(selected, ["current"]);
});
