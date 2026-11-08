const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const RANKING = [
  "deepseek/z-fast",
  "openai/z-fast",
  "google/z-fast",
  "anthropic/z-fast",
  "z-ai/z-fast",
  "anthropic/a-slow",
  "google/a-slow",
  "openai/a-slow",
  "anthropic/b-slower",
  "openai/b-slowest",
  "anthropic/c-slowest",
  "google/b-slowest",
  "z-ai/a-slow",
  "minimax/z-fast",
];
const MODELS = [...RANKING].reverse().map((value) => ({
  value,
  label: value,
  description: [RANKING[0], RANKING[5], RANKING[6], RANKING[7], RANKING[12]].includes(value)
    ? "search match"
    : "",
}));
const GROUPED = [
  "anthropic (4)",
  "anthropic/z-fast",
  "anthropic/a-slow",
  "anthropic/b-slower",
  "anthropic/c-slowest",
  "google (3)",
  "google/z-fast",
  "google/a-slow",
  "google/b-slowest",
  "openai (3)",
  "openai/z-fast",
  "openai/a-slow",
  "openai/b-slowest",
  "reasoning.custom.otherGroup (4)",
  "deepseek/z-fast",
  "z-ai/z-fast",
  "z-ai/a-slow",
  "minimax/z-fast",
];

async function mountList(t, overrides = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-model-ranking-",
    noExternal: ["react-i18next", "@tanstack/react-virtual"],
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
      `,
      // Expose every row without needing a scroll container or browser layout.
      "@tanstack/react-virtual": `
        import { useRef } from "react";
        export function useVirtualizer(options) {
          const current = useRef(options);
          current.current = options;
          const instance = useRef({
            getTotalSize: () => current.current.count * 40,
            getVirtualItems: () => Array.from({ length: current.current.count }, (_, index) => ({
              index, start: index * 40,
            })),
            scrollToOffset() {},
            scrollToIndex() {},
            measureElement() {},
          });
          return instance.current;
        }
      `,
    },
  });
  const { default: List } = await vite.ssrLoadModule("/components/ui/SearchableModelList.tsx");
  const selected = [];
  const props = {
    models: MODELS,
    modelRanking: RANKING,
    selectedModel: "",
    onModelSelect: (id) => selected.push(id),
    ...overrides,
  };
  let tree;
  function Harness() {
    tree = List(props);
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  // The refresh button wraps the field in a flex row when a live catalog offers one.
  const findCombobox = (node) => {
    if (!node || !node.props) return null;
    if (node.props.role === "combobox") return node;
    for (const child of React.Children.toArray(node.props.children)) {
      const match = findCombobox(child);
      if (match) return match;
    }
    return null;
  };
  const input = () => findCombobox(tree);
  const rows = () =>
    tree.props.children[1]
      ? tree.props.children[1].props.children.props.children.map((row) => row.props.children)
      : [];
  return {
    selected,
    rows,
    setProps: (patch) => {
      Object.assign(props, patch);
      return React.act(async () => root.render(React.createElement(Harness)));
    },
    order: () =>
      rows().map((row) =>
        row.props.role === "option"
          ? row.props.children.props.model.value
          : `${row.props.children[0].props.children} (${row.props.children[1].props.children})`
      ),
    search: (value) => React.act(async () => input().props.onChange({ target: { value } })),
    key: (key) => React.act(async () => input().props.onKeyDown({ key, preventDefault() {} })),
  };
}

test("larger providers lead, ties use provider name, and small providers share Other", async (t) => {
  const list = await mountList(t, { selectedModel: RANKING[1] });
  assert.deepEqual(list.order(), GROUPED);
  const cards = list.rows().filter((row) => row.props.role === "option");
  assert.equal(cards.filter((row) => row.props["aria-selected"]).length, 1);
  assert.equal(
    cards[0].props.children.props.model.label,
    "z-fast",
    "the header names the provider"
  );
  assert.equal(
    cards.at(-1).props.children.props.model.label,
    "minimax/z-fast",
    "Other keeps provider prefixes visible"
  );
  for (let index = 0; index < 5; index++) await list.key("ArrowDown");
  await list.key("Enter");
  assert.deepEqual(list.selected, ["google/z-fast"], "keyboard navigation skips provider headers");
});

test("search preserves provider order and keeps small matches in their existing groups", async (t) => {
  const list = await mountList(t);
  await list.search("SEARCH MATCH");
  assert.deepEqual(list.order(), [
    "anthropic (1)",
    "anthropic/a-slow",
    "google (1)",
    "google/a-slow",
    "openai (1)",
    "openai/a-slow",
    "reasoning.custom.otherGroup (2)",
    "deepseek/z-fast",
    "z-ai/a-slow",
  ]);
  await list.search("no matching model");
  assert.deepEqual(list.order(), [], "empty provider groups are hidden");
});

test("a saved model outside the ranking stays Selected without changing provider counts", async (t) => {
  const saved = { value: "openai/saved", label: "openai/saved" };
  const list = await mountList(t, {
    models: [saved, ...MODELS],
    selectedModel: saved.value,
  });
  assert.deepEqual(list.order(), ["reasoning.custom.selectedGroup (1)", saved.value, ...GROUPED]);
  await list.search("anthropic");
  assert.deepEqual(list.order(), [
    "reasoning.custom.selectedGroup (1)",
    saved.value,
    "anthropic (4)",
    "anthropic/z-fast",
    "anthropic/a-slow",
    "anthropic/b-slower",
    "anthropic/c-slowest",
  ]);
});

test("choosing a recommendation removes the previous unranked selection without changing provider order", async (t) => {
  const saved = { value: "openai/saved", label: "openai/saved" };
  const list = await mountList(t, {
    models: [saved, ...MODELS],
    selectedModel: saved.value,
  });
  assert.deepEqual(list.order(), ["reasoning.custom.selectedGroup (1)", saved.value, ...GROUPED]);
  await list.key("ArrowDown");
  await list.key("ArrowDown");
  await list.key("Enter");
  assert.deepEqual(list.selected, ["anthropic/z-fast"]);
  await list.setProps({ selectedModel: list.selected[0] });
  assert.deepEqual(list.order(), GROUPED);
  await list.search(saved.value);
  assert.deepEqual(list.order(), [], "the old saved selection is no longer selectable");
});

test("lists without recommendations keep alphabetical groups and their pinned selection", async (t) => {
  const list = await mountList(t, { modelRanking: undefined, selectedModel: RANKING[1] });
  assert.deepEqual(list.order(), [
    "reasoning.custom.selectedGroup (1)",
    "openai/z-fast",
    "anthropic (4)",
    "anthropic/a-slow",
    "anthropic/b-slower",
    "anthropic/c-slowest",
    "anthropic/z-fast",
    "deepseek (1)",
    "deepseek/z-fast",
    "google (3)",
    "google/a-slow",
    "google/b-slowest",
    "google/z-fast",
    "minimax (1)",
    "minimax/z-fast",
    "openai (2)",
    "openai/a-slow",
    "openai/b-slowest",
    "z-ai (2)",
    "z-ai/a-slow",
    "z-ai/z-fast",
  ]);
});
