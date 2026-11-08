const test = require("node:test");
const assert = require("node:assert/strict");
const { managedPolicy } = require("../helpers/harness/policyFixtures");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");

const modulePath = "/components/EnterpriseSection.tsx";
const props = {
  currentProvider: "bedrock",
  reasoningModel: "",
  setReasoningModel: () => {},
  setLocalReasoningProvider: () => {},
};
const tabs = (panel) => panel.find((node) => Array.isArray(node.props?.providers))[0]?.props;

test("managed workspaces only offer enterprise providers supported by desktop policy", async (t) => {
  const panel = await mountSettingsPanel(t, {
    module: modulePath,
    props,
    policy: {
      status: "managed",
      policy: managedPolicy({
        llm: { allowedModes: ["enterprise"], allowedEnterpriseProviders: ["bedrock", "azure"] },
      }),
    },
  });
  assert.deepEqual(
    tabs(panel).providers.map(({ id }) => id),
    ["bedrock"]
  );
  assert.equal(tabs(panel).selectedId, "bedrock");

  await panel.setPolicy({
    policy: managedPolicy({
      llm: { allowedModes: ["enterprise"], allowedEnterpriseProviders: ["azure"] },
    }),
  });
  assert.equal(tabs(panel), undefined);
});

test("unmanaged users can still select and configure Azure OpenAI", async (t) => {
  const selected = [];
  const panel = await mountSettingsPanel(t, {
    module: modulePath,
    props: { ...props, setLocalReasoningProvider: (provider) => selected.push(provider) },
    policy: { status: "unmanaged", policy: null },
  });
  await panel.selectTab("azure");
  assert.deepEqual(selected, ["azure"]);
  await panel.setProps({ currentProvider: "azure" });
  assert.equal(tabs(panel).selectedId, "azure");
  assert.equal(panel.find((node) => node.props?.provider === "azure").length, 1);
});
