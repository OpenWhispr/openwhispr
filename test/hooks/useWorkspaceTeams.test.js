const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const mountedRoots = new Map();

// A row as an API from before release 6 sends it: no capabilities, spaces or roles.
const olderRow = (id, name = id) => ({
  id,
  workspace_id: "w1",
  name,
  slug: id,
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

const currentRow = (id) => ({
  ...olderRow(id),
  member_count: 3,
  my_role: null,
  capabilities: { manage_members: true, manage_settings: true, leave: false },
  spaces: [],
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function loadHook(t) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__teamListCalls;
    delete globalThis.__teamListImpl;
    delete globalThis.__latestTeams;
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  globalThis.__teamListCalls = [];
  globalThis.__teamListImpl = async () => [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-teams-hook-",
    mockModules: {
      "/services/TeamsService": `
        export const TeamsService = {
          list: (workspaceId) => {
            globalThis.__teamListCalls.push(workspaceId);
            return globalThis.__teamListImpl(workspaceId);
          },
        };
      `,
    },
  });
  const { useWorkspaceTeams } = await vite.ssrLoadModule("/hooks/useWorkspaceTeams.ts");
  const held = await vite.ssrLoadModule("/lib/heldTeamDeletes.ts");
  function Harness({ workspaceId, enabled }) {
    globalThis.__latestTeams = useWorkspaceTeams(workspaceId, enabled);
    return null;
  }
  const root = createRoot(container);
  mountedRoots.set(t, root);
  const mount = (workspaceId, enabled) =>
    React.act(async () => {
      root.render(React.createElement(Harness, { workspaceId, enabled }));
    });
  return { mount, held, state: () => globalThis.__latestTeams };
}

const ids = (state) => state().teams.map((team) => team.id);

test("an answer for another workspace is dropped", async (t) => {
  const { mount, state } = await loadHook(t);
  const first = deferred();
  const second = deferred();
  const answers = { w1: first, w2: second };
  globalThis.__teamListImpl = (workspaceId) => answers[workspaceId].promise;

  await mount("w1", true);
  await mount("w2", true);
  assert.deepEqual(globalThis.__teamListCalls, ["w1", "w2"]);

  await React.act(async () => first.resolve([currentRow("old")]));
  assert.equal(state().status, "loading");
  assert.deepEqual(state().teams, []);

  await React.act(async () => second.resolve([currentRow("new")]));
  assert.equal(state().status, "ready");
  assert.deepEqual(ids(state), ["new"]);
});

test("a failed reload keeps the list and marks it stale", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__teamListImpl = async () => [currentRow("t1")];
  await mount("w1", true);
  assert.equal(state().stale, false);

  globalThis.__teamListImpl = async () => {
    throw new Error("offline");
  };
  let listed;
  await React.act(async () => {
    listed = await state().reload();
  });

  assert.equal(listed, null);
  assert.equal(state().status, "ready");
  assert.equal(state().stale, true);
  assert.deepEqual(ids(state), ["t1"]);

  globalThis.__teamListImpl = async () => [currentRow("t1")];
  await React.act(async () => state().reload());
  assert.equal(state().stale, false);
});

test("a failed first load is failed, not stale", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__teamListImpl = async () => {
    throw new Error("offline");
  };
  await mount("w1", true);
  assert.equal(state().status, "failed");
  assert.equal(state().stale, false);
  assert.equal(state().loads, 0);
});

test("a held team leaves the list and comes back on Undo", async (t) => {
  const { mount, held, state } = await loadHook(t);
  globalThis.__teamListImpl = async () => [currentRow("t1"), currentRow("t2")];
  await mount("w1", true);
  assert.deepEqual(ids(state), ["t1", "t2"]);

  await React.act(async () => held.holdTeam("t1"));
  assert.deepEqual(ids(state), ["t2"]);

  // The server still lists it, so a reload mustn't bring it back.
  await React.act(async () => state().reload());
  assert.deepEqual(ids(state), ["t2"]);

  await React.act(async () => held.releaseTeam("t1"));
  assert.deepEqual(ids(state), ["t1", "t2"]);
  assert.equal(state().loads, 2);
});

test("rows from an older API still render", async (t) => {
  const { mount, state } = await loadHook(t);
  const rows = [olderRow("t1", "Sales"), olderRow("t2", "Support")];
  globalThis.__teamListImpl = async () => rows;
  await mount("w1", true);

  assert.equal(state().status, "ready");
  // The hook adds nothing, so a missing field stays missing for the page to read as absent.
  assert.deepEqual(state().teams, rows);
});

test("a disabled hook reads nothing", async (t) => {
  const { mount, state } = await loadHook(t);
  await mount("w1", false);
  assert.equal(state().status, "idle");
  assert.deepEqual(globalThis.__teamListCalls, []);
});
