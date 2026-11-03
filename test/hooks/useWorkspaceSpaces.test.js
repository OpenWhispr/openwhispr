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

// A row as an API from before release 5 sends it: none of the directory's new fields.
const olderRow = (id, name = id) => ({
  id,
  workspace_id: "w1",
  name,
  description: null,
  emoji: null,
  member_count: 1,
  teams: [],
});

const currentRow = (id) => ({
  ...olderRow(id),
  is_default: false,
  is_open: true,
  admins: [{ user_id: "u1", name: "Ada", email: "ada@example.com", image: null }],
  my_role: null,
  my_direct_role: null,
  capabilities: null,
  can_join: true,
  sole_admin: false,
});

// Each list call returns a promise the test settles by hand, so it controls which answer lands first.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadHook(t) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__spaceListCalls;
    delete globalThis.__spaceListImpl;
    delete globalThis.__latestSpaces;
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  globalThis.__spaceListCalls = [];
  globalThis.__spaceListImpl = async () => [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-spaces-hook-",
    mockModules: {
      "/services/SpacesService": `
        export const SpacesService = {
          listInWorkspace: (workspaceId) => {
            globalThis.__spaceListCalls.push(workspaceId);
            return globalThis.__spaceListImpl(workspaceId);
          },
        };
      `,
    },
  });
  const { useWorkspaceSpaces } = await vite.ssrLoadModule("/hooks/useWorkspaceSpaces.ts");
  function Harness({ workspaceId, enabled }) {
    globalThis.__latestSpaces = useWorkspaceSpaces(workspaceId, enabled);
    return null;
  }
  const root = createRoot(container);
  mountedRoots.set(t, root);
  const mount = (workspaceId, enabled) =>
    React.act(async () => {
      root.render(React.createElement(Harness, { workspaceId, enabled }));
    });
  return { mount, state: () => globalThis.__latestSpaces };
}

test("the hook loads, then reloads", async (t) => {
  const { mount, state } = await loadHook(t);
  const first = deferred();
  globalThis.__spaceListImpl = () => first.promise;

  await mount("w1", true);
  assert.equal(state().status, "loading");
  assert.deepEqual(state().spaces, []);

  await React.act(async () => first.resolve([currentRow("s1")]));
  assert.equal(state().status, "ready");
  assert.equal(state().stale, false);
  assert.deepEqual(
    state().spaces.map((space) => space.id),
    ["s1"]
  );

  globalThis.__spaceListImpl = async () => [currentRow("s1"), currentRow("s2")];
  let listed;
  await React.act(async () => {
    listed = await state().reload();
  });

  assert.deepEqual(
    state().spaces.map((space) => space.id),
    ["s1", "s2"]
  );
  // The caller gets the list it read, to check a row against.
  assert.deepEqual(
    listed.map((space) => space.id),
    ["s1", "s2"]
  );
  assert.deepEqual(globalThis.__spaceListCalls, ["w1", "w1"]);
});

test("it counts the reads that landed, so a consumer can tell a list is newer than a moment", async (t) => {
  const { mount, state } = await loadHook(t);
  const first = deferred();
  globalThis.__spaceListImpl = () => first.promise;

  await mount("w1", true);
  assert.equal(state().loads, 0);

  await React.act(async () => first.resolve([currentRow("s1")]));
  assert.equal(state().loads, 1);

  // A read that fails leaves the list, and the count, as they were.
  globalThis.__spaceListImpl = async () => {
    throw new Error("offline");
  };
  await React.act(async () => {
    await state().reload();
  });
  assert.equal(state().loads, 1);
  assert.equal(state().stale, true);

  globalThis.__spaceListImpl = async () => [currentRow("s1")];
  await React.act(async () => {
    await state().reload();
  });
  assert.equal(state().loads, 2);
});

test("a read overtaken by a newer one isn't counted", async (t) => {
  const { mount, state } = await loadHook(t);
  const slow = deferred();
  const fast = deferred();
  const answers = [slow, fast];
  globalThis.__spaceListImpl = () => answers.shift().promise;
  await mount("w1", true);

  let newest;
  await React.act(async () => {
    newest = state().reload();
    fast.resolve([currentRow("s2")]);
    await newest;
    slow.resolve([currentRow("s1")]);
  });
  await React.act(async () => {});

  assert.equal(state().loads, 1);
  assert.deepEqual(
    state().spaces.map((space) => space.id),
    ["s2"]
  );
});

test("a failed first load has status failed, and reload retries", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__spaceListImpl = async () => {
    throw new Error("offline");
  };

  await mount("w1", true);
  assert.equal(state().status, "failed");
  assert.deepEqual(state().spaces, []);
  assert.equal(state().stale, false);

  globalThis.__spaceListImpl = async () => [currentRow("s1")];
  await React.act(async () => state().reload());

  assert.equal(state().status, "ready");
  assert.equal(state().spaces.length, 1);
});

test("a failed reload keeps the list and sets stale", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__spaceListImpl = async () => [currentRow("s1")];
  await mount("w1", true);

  globalThis.__spaceListImpl = async () => {
    throw new Error("offline");
  };
  let listed;
  // reload resolves even though the list call rejects.
  await React.act(async () => {
    listed = await state().reload();
  });

  assert.equal(listed, null);
  assert.equal(state().status, "ready");
  assert.equal(state().stale, true);
  assert.deepEqual(
    state().spaces.map((space) => space.id),
    ["s1"]
  );

  globalThis.__spaceListImpl = async () => [currentRow("s1")];
  await React.act(async () => state().reload());
  assert.equal(state().stale, false);
});

test("an answer for another workspace is dropped", async (t) => {
  const { mount, state } = await loadHook(t);
  const first = deferred();
  const second = deferred();
  const answers = { w1: first, w2: second };
  globalThis.__spaceListImpl = (workspaceId) => answers[workspaceId].promise;

  await mount("w1", true);
  await mount("w2", true);
  assert.deepEqual(globalThis.__spaceListCalls, ["w1", "w2"]);

  // The old workspace answers first; its rows never show for the new one.
  await React.act(async () => first.resolve([currentRow("old")]));
  assert.equal(state().status, "loading");
  assert.deepEqual(state().spaces, []);

  await React.act(async () => second.resolve([currentRow("new")]));
  assert.equal(state().status, "ready");
  assert.deepEqual(
    state().spaces.map((space) => space.id),
    ["new"]
  );

  // And an answer that lands after the new one is still ignored.
  const late = deferred();
  const lateFirst = deferred();
  globalThis.__spaceListImpl = (workspaceId) => (workspaceId === "w1" ? lateFirst : late).promise;
  await mount("w1", true);
  await mount("w2", true);
  await React.act(async () => late.resolve([currentRow("new-again")]));
  await React.act(async () => lateFirst.resolve([currentRow("old-again")]));
  assert.deepEqual(
    state().spaces.map((space) => space.id),
    ["new-again"]
  );
});

test("a reload kept from another workspace leaves the current list alone", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__spaceListImpl = async (workspaceId) => [currentRow(`s-${workspaceId}`)];
  await mount("w1", true);
  // A caller (a join) keeps the reload it got while w1 was showing.
  const staleReload = state().reload;

  const second = deferred();
  globalThis.__spaceListImpl = (workspaceId) =>
    workspaceId === "w2" ? second.promise : Promise.resolve([currentRow("late")]);
  await mount("w2", true);
  let listed;
  await React.act(async () => {
    listed = await staleReload();
  });
  await React.act(async () => second.resolve([currentRow("s2")]));

  // The stale reload never asked for w1 again, and w2's answer was not dropped.
  assert.equal(listed, null);
  assert.deepEqual(globalThis.__spaceListCalls, ["w1", "w2"]);
  assert.deepEqual(
    state().spaces.map((space) => space.id),
    ["s2"]
  );
});

test("rows from an older API still render", async (t) => {
  const { mount, state } = await loadHook(t);
  const rows = [olderRow("s1", "Product"), olderRow("s2", "Support")];
  globalThis.__spaceListImpl = async () => rows;

  await mount("w1", true);

  assert.equal(state().status, "ready");
  assert.equal(state().spaces.length, 2);
  // The hook adds nothing to a row, so a missing field stays missing for the page to read as absent.
  assert.deepEqual(state().spaces, rows);
  assert.ok(!("admins" in state().spaces[0]));
  assert.ok(!("can_join" in state().spaces[0]));
});

test("without a workspace or when disabled it stays idle and never calls the API", async (t) => {
  const { mount, state } = await loadHook(t);

  await mount(null, true);
  assert.equal(state().status, "idle");
  assert.deepEqual(state().spaces, []);
  let listed;
  await React.act(async () => {
    listed = await state().reload();
  });
  assert.equal(listed, null);

  await mount("w1", false);
  assert.equal(state().status, "idle");
  assert.deepEqual(globalThis.__spaceListCalls, []);

  await mount("w1", true);
  assert.deepEqual(globalThis.__spaceListCalls, ["w1"]);
  assert.equal(state().status, "ready");
});
