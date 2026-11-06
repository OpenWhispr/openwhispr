const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const PROFILE = { platform: "darwin", name: "MacBook Pro", memoryGb: 48 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function setup(t) {
  let root = null;
  // Registered first so it runs before the globals are taken down
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const reads = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getComputerProfile() {
          reads.push(deferred());
          return reads.at(-1).promise;
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-computer-profile-" });
  const { useComputerProfile } = await vite.ssrLoadModule("/hooks/useComputerProfile.ts");
  let value;
  function Harness() {
    value = useComputerProfile();
    return null;
  }
  const mount = async () => {
    root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
  };
  const unmount = async () => {
    await React.act(async () => root.unmount());
    root = null;
  };
  const settle = (fn) => React.act(async () => fn());
  return { reads, mount, unmount, settle, value: () => value };
}

test("null until main answers, then the profile", async (t) => {
  const s = await setup(t);
  await s.mount();
  assert.equal(s.value(), null);
  await s.settle(() => s.reads[0].resolve(PROFILE));
  assert.deepEqual(s.value(), PROFILE);
});

test("a later mount reuses the answer without asking again", async (t) => {
  const s = await setup(t);
  await s.mount();
  await s.settle(() => s.reads[0].resolve(PROFILE));
  await s.unmount();
  await s.mount();
  await s.settle(() => {});
  assert.deepEqual(s.value(), PROFILE);
  assert.equal(s.reads.length, 1);
});

test("a rejected read stays null and the next mount asks again", async (t) => {
  const s = await setup(t);
  await s.mount();
  await s.settle(() => s.reads[0].reject(new Error("ipc closed")));
  assert.equal(s.value(), null);
  await s.unmount();
  await s.mount();
  assert.equal(s.reads.length, 2, "the failed read was not kept");
  await s.settle(() => s.reads[1].resolve(PROFILE));
  assert.deepEqual(s.value(), PROFILE);
});
