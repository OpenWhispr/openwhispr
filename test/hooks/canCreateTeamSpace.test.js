const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// canManageWorkspace stays real: the rule under test is which roles it lets through.
test("team space creation is offered to workspace managers and to users with none yet", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  installBrowserGlobals(t);
  const container = installHookDom(t);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-can-create-team-space-",
    mockModules: {
      "/useAuth": "export const useAuth = () => ({ isSignedIn: globalThis.__state.isSignedIn });",
      "/useTeamSpacesCapability": `
        export const useTeamSpacesCapability = (isSignedIn) =>
          isSignedIn && globalThis.__state.teamSpacesAvailable;
      `,
      "/useWorkspace": `
        export const useWorkspace = () => ({
          workspaces: globalThis.__state.workspaces,
          loaded: globalThis.__state.loaded,
        });
      `,
    },
  });
  const { useCanCreateTeamSpace } = await vite.ssrLoadModule("/hooks/useCanCreateTeamSpace.ts");

  let latest = null;
  function Harness() {
    latest = useCanCreateTeamSpace();
    return null;
  }

  root = createRoot(container);
  t.after(() => {
    delete globalThis.__state;
  });
  const canCreate = async (state) => {
    globalThis.__state = { isSignedIn: true, teamSpacesAvailable: true, loaded: true, ...state };
    await React.act(async () => {
      root.render(React.createElement(Harness, { key: JSON.stringify(state) }));
      await Promise.resolve();
    });
    return latest;
  };

  assert.equal(await canCreate({ isSignedIn: false, workspaces: [] }), false);
  assert.equal(await canCreate({ teamSpacesAvailable: false, workspaces: [] }), false);
  assert.equal(await canCreate({ loaded: false, workspaces: [] }), false);
  // No workspace yet: the dialog walks the user through creating one.
  assert.equal(await canCreate({ workspaces: [] }), true);
  assert.equal(await canCreate({ workspaces: [{ id: "w1", role: "member" }] }), false);
  assert.equal(await canCreate({ workspaces: [{ id: "w1", role: "admin" }] }), true);
  assert.equal(
    await canCreate({
      workspaces: [
        { id: "w1", role: "member" },
        { id: "w2", role: "owner" },
      ],
    }),
    true
  );
});
