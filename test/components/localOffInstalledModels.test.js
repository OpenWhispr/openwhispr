const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { managedPolicy } = require("../helpers/harness/policyFixtures");
const { createRendererServer } = require("../lib/rendererTestHarness");

const managed = (allowedModes) => ({
  status: "managed",
  managed: true,
  appVersion: "1.11.1",
  policy: managedPolicy({
    transcription: { allowedModes, allowedLocalModels: null },
    llm: { allowedModes, allowedLocalModels: null },
  }),
});

const DOM_GLOBALS = [
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "getComputedStyle",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "KeyboardEvent",
  "HTMLInputElement",
  "NodeFilter",
];

let happyWindow;

test.before(async () => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

async function renderList(t, { policy, scope = "transcription" }) {
  const deleted = [];
  let cleared = false;
  const remove = async (id) => {
    deleted.push(id);
    return { success: true };
  };
  happyWindow.electronAPI = {
    listWhisperModels: async () => ({
      success: true,
      models: [
        { model: "base", downloaded: !cleared && !deleted.includes("base") },
        { model: "small", downloaded: false },
      ],
    }),
    listParakeetModels: async () => ({
      success: true,
      models: [{ model: "parakeet-tdt-0.6b-v3", downloaded: !cleared }],
    }),
    modelGetAll: async () => [
      { id: "qwen3.5-4b-q4_k_m", name: "Qwen", isDownloaded: true },
      { id: "qwen3.5-9b-q4_k_m", name: "Big Qwen", isDownloaded: false },
    ],
    deleteWhisperModel: remove,
    deleteParakeetModel: remove,
    modelDelete: remove,
    modelGetActiveDownloads: async () => [],
    onModelDownloadProgress: () => () => {},
    onWhisperDownloadProgress: () => () => {},
    onParakeetDownloadProgress: () => () => {},
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-off-installed-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState(policy);
  const { LocalOffInstalledModels } = await vite.ssrLoadModule(
    "/components/settings/LocalOffInstalledModels.tsx"
  );
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(host);
  const root = createRoot(host);
  const settle = () =>
    React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  await React.act(async () =>
    root.render(
      React.createElement(
        ToastContext.Provider,
        { value: { toast: () => "toast" } },
        React.createElement(LocalOffInstalledModels, { scope })
      )
    )
  );
  await settle();
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  const deleteButtons = () => [...host.querySelectorAll('button[aria-label="Delete"]')];
  return {
    deleted,
    deleteButtons,
    html: () => host.textContent ?? "",

    async clearAllModels() {
      cleared = true;
      await React.act(async () => {
        happyWindow.dispatchEvent(new happyWindow.Event("openwhispr-models-cleared"));
      });
      await settle();
    },
    async deleteFirst() {
      await React.act(async () => deleteButtons()[0].click());
      await settle();
      const confirm = [
        ...happyWindow.document.body.querySelectorAll('[role="dialog"] button'),
      ].find(
        (button) =>
          button.textContent !== "Cancel" && button.getAttribute("aria-label") !== "Delete"
      );
      if (!confirm) throw new Error(happyWindow.document.body.innerHTML.slice(0, 1500));
      await React.act(async () => confirm.click());
      await settle();
    },
  };
}

test("with Local off, a member can still see and delete each installed speech model", async (t) => {
  const list = await renderList(t, { policy: managed(["openwhispr"]) });

  assert.match(list.html(), /Installed local models/);
  assert.match(list.html(), /Base/);
  assert.match(list.html(), /Parakeet/);
  assert.doesNotMatch(list.html(), /Small/, "a model that isn't installed isn't listed");
  assert.equal(list.deleteButtons().length, 2);

  await list.deleteFirst();

  assert.deepEqual(list.deleted, ["base"]);
  assert.doesNotMatch(list.html(), /Base/);
});

test("with Local off, each installed AI text model is listed for its own scope", async (t) => {
  const list = await renderList(t, { policy: managed(["openwhispr"]), scope: "llm" });

  assert.match(list.html(), /Qwen/);
  assert.doesNotMatch(list.html(), /Big Qwen/);
});

for (const [label, policy] of [
  ["Local allowed", managed(["local", "openwhispr"])],
  ["a guest", { status: "idle", managed: false, policy: null, appVersion: null }],
  ["an unmanaged member", { status: "unmanaged", managed: false, policy: null, appVersion: null }],
]) {
  test(`${label} sees no such section: the pickers already list installed models`, async (t) => {
    const list = await renderList(t, { policy });

    assert.equal(list.html(), "");
  });
}

test("below the version floor the section gives that reason, not Local off", async (t) => {
  const policy = managed(["local"]);
  policy.policy.minAppVersion = "9.9.9";
  const list = await renderList(t, { policy });

  assert.match(list.html(), /Base/);
  assert.match(list.html(), /Update OpenWhispr/);
  assert.doesNotMatch(list.html(), /disabled local processing/);
});

test("removing all models from Settings empties the section", async (t) => {
  const list = await renderList(t, { policy: managed(["openwhispr"]) });
  assert.equal(list.deleteButtons().length, 2);

  await list.clearAllModels();

  assert.equal(list.deleteButtons().length, 0);
  assert.equal(list.html(), "");
});

test("a family with nothing installed adds no empty row", async (t) => {
  const list = await renderList(t, { policy: managed(["openwhispr"]) });

  assert.doesNotMatch(list.html(), /No models available/);
  await list.deleteFirst();
  assert.doesNotMatch(list.html(), /No models available/);
});
