const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const WORKSPACE = { id: "acme", name: "Acme", role: "owner" };

async function loadServer(t) {
  t.after(() => {
    delete globalThis.__workspaceState;
  });
  installBrowserGlobals(t);
  return createRendererServer(t, {
    cachePrefix: "openwhispr-settings-workspace-frame-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/CreateWorkspaceDialog": "export default function Mock() { return null; }",
      "/InviteTeammateDialog": "export default function Mock() { return null; }",
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) => selector(globalThis.__workspaceState);
      `,
      "/hooks/useAuth": "export const useAuth = () => ({ isSignedIn: true });",
    },
  });
}

const LOCALES = ["ar", "de", "en", "es", "fr", "it", "ja", "pt", "ru", "zh-CN", "zh-TW"];

test("Settings shows the active workspace, never a Personal card", async (t) => {
  const vite = await loadServer(t);
  const { useSettingsWorkspace } = await vite.ssrLoadModule(
    "/components/settings/useSettingsWorkspace.ts"
  );
  const { default: Frame } = await vite.ssrLoadModule(
    "/components/settings/SettingsWorkspaceFrame.tsx"
  );
  const own = { id: "mine", name: "Ada's workspace", role: "owner", is_default: true };
  const beta = { id: "beta", name: "Beta", role: "member", is_default: false };
  globalThis.__workspaceState = {
    workspaces: [own, beta],
    activeWorkspaceId: "beta",
    loaded: true,
    loading: false,
    error: false,
    refresh: async () => {},
  };
  let state;
  const Page = () => {
    state = useSettingsWorkspace();
    return createElement(Frame, { state }, (workspace) => `page:${workspace.id}`);
  };

  const markup = renderToStaticMarkup(createElement(Page));

  assert.equal(state.status, "ready");
  assert.equal(state.workspace, beta);
  assert.ok(markup.includes("page:beta"));
  assert.ok(!markup.includes("settingsPage.workspace.personal"));
  // The Personal card's copy is gone from every locale.
  for (const locale of LOCALES) {
    const { settingsPage } = require(`../../src/locales/${locale}/translation.json`);
    assert.equal(settingsPage.workspace.personal, undefined, locale);
  }
});

test("useSettingsWorkspace shows a workspace even with none active, never Personal", async (t) => {
  const vite = await loadServer(t);
  const { useSettingsWorkspace } = await vite.ssrLoadModule(
    "/components/settings/useSettingsWorkspace.ts"
  );
  globalThis.__workspaceState = {
    workspaces: [WORKSPACE],
    activeWorkspaceId: null,
    loaded: true,
    loading: false,
    error: false,
    refresh: async () => {},
  };
  let state;
  const Probe = () => {
    state = useSettingsWorkspace();
    return null;
  };

  renderToStaticMarkup(createElement(Probe));

  assert.equal(state.status, "ready");
  assert.equal(state.workspace, WORKSPACE);
});
