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

const personalState = {
  status: "personal",
  workspace: null,
  workspaces: [WORKSPACE],
  retry: () => {},
};

test("in Personal the frame asks to choose a workspace instead of creating one", async (t) => {
  const vite = await loadServer(t);
  const { default: Frame } = await vite.ssrLoadModule(
    "/components/settings/SettingsWorkspaceFrame.tsx"
  );

  const markup = renderToStaticMarkup(
    createElement(Frame, { state: personalState, onChooseWorkspace: () => {} }, () => "page")
  );

  assert.ok(markup.includes("settingsPage.workspace.personal.title"));
  assert.ok(markup.includes("workspaces.exit.chooseWorkspace"));
  assert.ok(!markup.includes("settingsPage.workspace.empty.create"));
  assert.ok(!markup.includes("page"));
});

test("useSettingsWorkspace reports Personal and no workspace while it's chosen", async (t) => {
  const vite = await loadServer(t);
  const { useSettingsWorkspace } = await vite.ssrLoadModule(
    "/components/settings/useSettingsWorkspace.ts"
  );
  globalThis.__workspaceState = {
    workspaces: [WORKSPACE],
    activeWorkspaceId: null,
    personalSelected: true,
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

  assert.equal(state.status, "personal");
  assert.equal(state.workspace, null);
});
