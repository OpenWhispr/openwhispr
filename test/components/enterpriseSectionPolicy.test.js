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

test("an Azure-only policy hides manual setup and preserves every scope for policy removal", async (t) => {
  const scopes = [
    ["dictationCleanup", "cleanup"],
    ["dictationAgent", "dictationAgent"],
    ["noteFormatting", "noteFormatting"],
    ["chatIntelligence", "chatAgent"],
    ["dictationTranslation", "translation"],
  ];
  const panel = await mountSettingsPanel(t, {
    module: "/components/settings/InferenceConfigEditor.tsx",
    props: { scope: "dictationCleanup" },
    settings: {
      enterpriseSetupMode: "manual",
      ...Object.fromEntries(
        scopes.flatMap(([, prefix]) => [
          [`${prefix}Mode`, "enterprise"],
          [`${prefix}Provider`, "azure"],
          [`${prefix}Model`, "personal-deployment"],
        ])
      ),
    },
    policy: { status: "unmanaged", policy: null },
  });
  const enterpriseSection = () =>
    panel.find((node) => typeof node.props?.currentProvider === "string")[0]?.props;

  for (const [scope, prefix] of scopes) {
    await panel.setProps({ scope });
    assert.equal(enterpriseSection().currentProvider, "azure", scope);
    await panel.setPolicy({
      status: "managed",
      policy: managedPolicy({
        llm: { allowedModes: ["enterprise"], allowedEnterpriseProviders: ["azure"] },
      }),
    });
    assert.equal(enterpriseSection(), undefined, scope);
    assert.equal(panel.state()[`${prefix}Provider`], "azure", scope);
    assert.equal(panel.state()[`${prefix}Model`], "personal-deployment", scope);
    await panel.setPolicy({ status: "unmanaged", policy: null });
    assert.equal(enterpriseSection().currentProvider, "azure", scope);
    assert.equal(enterpriseSection().reasoningModel, "personal-deployment", scope);
  }
});
