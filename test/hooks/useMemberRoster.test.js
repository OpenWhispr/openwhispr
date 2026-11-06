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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadHook(t, load) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__roster;
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-member-roster-hook-",
  });
  const { useMemberRoster } = await vite.ssrLoadModule("/hooks/useMemberRoster.ts");
  function Harness() {
    globalThis.__roster = useMemberRoster(load);
    return null;
  }
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => root.render(React.createElement(Harness)));
  return () => globalThis.__roster;
}

test("an older read that lands after a newer one is dropped", async (t) => {
  const reads = [deferred(), deferred(), deferred()];
  let next = 0;
  const roster = await loadHook(t, () => reads[next++].promise);
  await React.act(async () => reads[0].resolve(["misa", "ethan"]));

  // Two reloads after changes; the first one's answer is the older list.
  let older;
  let newer;
  await React.act(async () => {
    older = roster().reload();
    newer = roster().reload();
  });
  await React.act(async () => reads[2].resolve(["ethan"]));
  await React.act(async () => reads[1].resolve(["misa", "ethan"]));
  await React.act(async () => Promise.all([older, newer]));

  assert.deepEqual(roster().members, ["ethan"]);
  assert.equal(roster().loading, false);
});

test("a failed read keeps what it failed with", async (t) => {
  const failure = new Error("Team not found");
  const roster = await loadHook(t, async () => {
    throw failure;
  });

  assert.equal(roster().loadFailed, true);
  assert.equal(roster().loadError, failure);
});
