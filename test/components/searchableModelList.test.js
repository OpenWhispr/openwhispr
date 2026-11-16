const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");

const MODULE = "/components/ui/SearchableModelList.tsx";
const SEARCH = "reasoning.custom.searchPlaceholder";
const CLEAR = "reasoning.custom.clearSearch";

const MODELS = [
  { value: "glm-5.3", label: "GLM-5.3", description: "Flagship GLM model" },
  { value: "kimi-k3", label: "Kimi K3", description: "Multimodal Kimi model" },
  { value: "hy4", label: "Hy4", description: "productivity model" },
];

const mount = (t) =>
  mountSettingsPanel(t, {
    module: MODULE,
    props: { models: MODELS, selectedModel: "", onModelSelect() {} },
  });

const searchField = (panel) => panel.find((node) => node.props?.role === "combobox")[0];
const clearButton = (panel) => panel.find((node) => node.props?.["aria-label"] === CLEAR)[0];

test("the search starts empty with no clear button", async (t) => {
  const panel = await mount(t);

  assert.equal(searchField(panel).props.value, "");
  assert.equal(clearButton(panel), undefined);
});

test("typing shows a clear button that empties the field", async (t) => {
  const panel = await mount(t);
  await panel.type(SEARCH, "glm");

  assert.equal(searchField(panel).props.value, "glm");
  assert.ok(clearButton(panel), "clear button appears once there is a query");

  await React.act(async () => {
    clearButton(panel).props.onClick();
  });

  assert.equal(searchField(panel).props.value, "");
  assert.equal(clearButton(panel), undefined);
});
