const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("closing Settings with the Bedrock session token focused commits its draft", async (t) => {
  const saved = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        saveBedrockSessionToken: async (value) => {
          saved.push(value);
        },
      },
      dispatchEvent: () => true,
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next":
        'export const useTranslation = () => ({ t: (key) => key }); export const initReactI18next = { type: "3rdParty", init() {} };',
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ bedrockAuthMode: "keys", bedrockSessionToken: "old-session" });
  const { default: Panel } = await vite.ssrLoadModule("/components/EnterpriseProviderConfig.tsx");
  const props = { provider: "bedrock", reasoningModel: "", setReasoningModel() {} };
  function findToken(node) {
    if (Array.isArray(node)) return node.map(findToken).find(Boolean);
    if (node?.props?.value === "old-session") return node;
    return node?.props && findToken(node.props.children);
  }
  let token;
  function Harness() {
    const config = Panel(props);
    token = findToken(config.type(config.props));
    return null;
  }
  const root = createRoot(container);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => token.props.onChange({ target: { value: "$GROQ_API_KEY" } }));
  assert.equal(useSettingsStore.getState().bedrockSessionToken, "old-session");
  await React.act(async () => root.unmount());
  assert.equal(useSettingsStore.getState().bedrockSessionToken, "$GROQ_API_KEY");
  await React.act(async () => t.mock.timers.tick(250));
  assert.deepEqual(saved, ["$GROQ_API_KEY"]);
});
