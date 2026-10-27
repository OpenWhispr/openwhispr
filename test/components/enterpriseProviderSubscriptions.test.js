const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");
const { enterpriseProviderMocks } = require("../lib/enterpriseProviderFixture");

test("retained Enterprise panels expose current credential configs and preserve catalog state", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__enterprisePanels;
  });
  const observed = (globalThis.__enterprisePanels = {
    config: {},
    models: [],
    inputs: [],
    apiKeys: [],
    catalogCalls: [],
    catalog: null,
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        listBedrockModels: async (config) => {
          observed.catalogCalls.push(config);
          return { success: true, models: [{ value: "catalog-model", label: "Catalog model" }] };
        },
      },
    },
  });
  const container = installHostDom(t);
  // React's native select reconciliation needs an options collection.
  const document = container.ownerDocument;
  const createElement = document.createElement;
  document.createElement = (tag) => {
    const node = createElement(tag);
    if (tag === "select") Object.defineProperty(node, "options", { get: () => node.childNodes });
    return node;
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-subscriptions-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      ...enterpriseProviderMocks("__enterprisePanels.store", {
        providers: ["bedrock", "azure", "vertex"],
        values: {
          bedrockSessionToken: "fake-session",
          azureEndpoint: "https://example.openai.azure.com",
          azureApiKey: "fake-azure",
          azureDeploymentName: "deployment",
          azureApiVersion: "2024-10-21",
          vertexProject: "project",
          vertexApiKey: "fake-vertex",
        },
        registry: `export const REASONING_PROVIDERS = {
          bedrock: {models: [{value: "us.model", label: "Bedrock model"}]},
          vertex: {models: [{value: "vertex-model", label: "Vertex model"}]},
        };`,
      }),
      "/TestConnectionButton": `export default function TestConnectionButton({provider, getConfig}) {
        globalThis.__enterprisePanels.config[provider] = getConfig;
        return null;
      }`,
      "/ui/button": `export function Button(props) { globalThis.__enterprisePanels.browse = props.onClick; return null; }`,
      "/ui/input": `export function Input(props) { globalThis.__enterprisePanels.inputs.push(props); return null; }`,
      "/ui/ApiKeyInput": `export default function ApiKeyInput(props) { globalThis.__enterprisePanels.apiKeys.push(props); return null; }`,
      "/ui/ModelCardList": `export default function ModelCardList({models}) { globalThis.__enterprisePanels.models.push(models); return null; }`,
      "/ui/CustomModelInput": `export default function CustomModelInput() { return null; }`,
      "/ui/SearchableModelList": `
        import React from "react";
        export default function SearchableModelList({models}) {
          const [draft, setDraft] = React.useState("");
          globalThis.__enterprisePanels.catalog = {models, draft, setDraft};
          return null;
        }
      `,
    },
  });
  const { default: EnterpriseProviderConfig } = await vite.ssrLoadModule(
    "/components/EnterpriseProviderConfig.tsx"
  );
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        ...["bedrock", "azure", "vertex"].map((provider) =>
          React.createElement(
            "div",
            { key: provider, hidden: provider !== "azure" },
            React.createElement(EnterpriseProviderConfig, {
              provider,
              reasoningModel: "us.model",
              setReasoningModel() {},
            })
          )
        )
      )
    )
  );
  const update = (patch) => React.act(async () => observed.store.setState(patch));
  await update({ customDictionary: ["unrelated"] });

  // Secrets commit once through the key editor, never on every keystroke.
  const isSessionToken = (props) => props.id?.endsWith("-session-token");
  assert.equal(observed.inputs.some(isSessionToken), false);
  assert.equal(
    observed.apiKeys.findLast(isSessionToken).setApiKey,
    observed.store.getState().setBedrockSessionToken
  );

  await update({ bedrockRegion: "eu-west-1", bedrockSecretAccessKey: "changed-secret" });
  assert.equal(observed.models.at(-1)[0].value, "eu.model");
  assert.equal(observed.config.bedrock().bedrockSecretAccessKey, "changed-secret");
  await React.act(async () => observed.browse());
  assert.equal(observed.catalog.models[0].value, "catalog-model");
  assert.equal(observed.catalogCalls[0].bedrockRegion, "eu-west-1");
  assert.equal(observed.catalogCalls[0].bedrockProfile, "");
  await React.act(async () => observed.catalog.setDraft("unsaved filter"));

  const endpoint = observed.inputs.findLast(
    (input) => input.placeholder === "https://yourresource.openai.azure.com"
  );
  await React.act(async () =>
    endpoint.onChange({ target: { value: "https://new.openai.azure.com" } })
  );
  await update({ azureApiKey: "changed-azure", azureDeploymentName: "new-deployment" });
  assert.equal(observed.config.azure().azureEndpoint, "https://new.openai.azure.com");
  assert.equal(observed.config.azure().apiKey, "changed-azure");
  assert.equal(observed.config.azure().model, "new-deployment");
  assert.equal(observed.catalog.draft, "unsaved filter");
  assert.equal(
    observed.catalogCalls.length,
    1,
    "unrelated provider edits do not reload the catalog"
  );

  await update({
    vertexProject: "new-project",
    vertexLocation: "us-east1",
    vertexApiKey: "changed-vertex",
  });
  assert.deepEqual(observed.config.vertex(), {
    vertexProject: "new-project",
    vertexLocation: "us-east1",
    apiKey: "changed-vertex",
    model: "us.model",
  });
  await update({ bedrockAuthMode: "sso", vertexAuthMode: "adc" });
  assert.deepEqual(observed.config.bedrock(), {
    bedrockRegion: "eu-west-1",
    bedrockProfile: "work",
    bedrockAccessKeyId: "",
    bedrockSecretAccessKey: "",
    bedrockSessionToken: "",
    model: "us.model",
  });
  assert.equal(observed.config.vertex().apiKey, "", "ADC does not send the saved API key");
  assert.equal(observed.catalog.draft, "unsaved filter");
});
