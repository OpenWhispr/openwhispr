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

const guest = (email) => ({ email, name: null, image: null, notes: [] });

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
    delete globalThis.__guestListCalls;
    delete globalThis.__guestListImpl;
    delete globalThis.__latestGuests;
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  globalThis.__guestListCalls = [];
  globalThis.__guestListImpl = async () => [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-guests-hook-",
    mockModules: {
      "/services/GuestsService": `
        export const GuestsService = {
          list: (workspaceId) => {
            globalThis.__guestListCalls.push(workspaceId);
            return globalThis.__guestListImpl(workspaceId);
          },
        };
      `,
    },
  });
  const { useWorkspaceGuests } = await vite.ssrLoadModule("/hooks/useWorkspaceGuests.ts");
  function Harness({ workspaceId }) {
    globalThis.__latestGuests = useWorkspaceGuests(workspaceId);
    return null;
  }
  const root = createRoot(container);
  mountedRoots.set(t, root);
  const mount = (workspaceId) =>
    React.act(async () => {
      root.render(React.createElement(Harness, { workspaceId }));
    });
  return { mount, state: () => globalThis.__latestGuests };
}

test("loads, then ready", async (t) => {
  const { mount, state } = await loadHook(t);
  const pending = deferred();
  globalThis.__guestListImpl = () => pending.promise;
  await mount("w1");
  assert.equal(state().status, "loading");

  await React.act(async () => pending.resolve([guest("a@x.com")]));
  assert.equal(state().status, "ready");
  assert.deepEqual(
    state().guests.map((g) => g.email),
    ["a@x.com"]
  );
  assert.equal(state().error, null);
  assert.deepEqual(globalThis.__guestListCalls, ["w1"]);
});

test("a failure is failed with a classified error", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__guestListImpl = async () => {
    throw new Error("offline");
  };
  await mount("w1");
  assert.equal(state().status, "failed");
  assert.deepEqual(state().error, { kind: "failed" });
  assert.deepEqual(state().guests, []);
});

test("an answer for another workspace is dropped", async (t) => {
  const { mount, state } = await loadHook(t);
  const first = deferred();
  const second = deferred();
  const answers = { w1: first, w2: second };
  globalThis.__guestListImpl = (workspaceId) => answers[workspaceId].promise;

  await mount("w1");
  await mount("w2");
  assert.deepEqual(globalThis.__guestListCalls, ["w1", "w2"]);

  await React.act(async () => first.resolve([guest("old@x.com")]));
  assert.equal(state().status, "loading");
  assert.deepEqual(state().guests, []);

  await React.act(async () => second.resolve([guest("new@x.com")]));
  assert.equal(state().status, "ready");
  assert.deepEqual(
    state().guests.map((g) => g.email),
    ["new@x.com"]
  );
});

test("reload refetches", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__guestListImpl = async () => [guest("a@x.com")];
  await mount("w1");

  globalThis.__guestListImpl = async () => [guest("a@x.com"), guest("b@x.com")];
  await React.act(async () => state().reload());
  assert.equal(state().guests.length, 2);
  assert.deepEqual(globalThis.__guestListCalls, ["w1", "w1"]);
});

test("a failed reload keeps the last list", async (t) => {
  const { mount, state } = await loadHook(t);
  globalThis.__guestListImpl = async () => [guest("a@x.com")];
  await mount("w1");

  globalThis.__guestListImpl = async () => {
    throw new Error("offline");
  };
  await React.act(async () => state().reload());
  assert.equal(state().status, "ready");
  assert.deepEqual(
    state().guests.map((g) => g.email),
    ["a@x.com"]
  );
  assert.deepEqual(state().error, { kind: "failed" });

  globalThis.__guestListImpl = async () => [guest("b@x.com")];
  await React.act(async () => state().reload());
  assert.equal(state().error, null);
  assert.deepEqual(
    state().guests.map((g) => g.email),
    ["b@x.com"]
  );
});
