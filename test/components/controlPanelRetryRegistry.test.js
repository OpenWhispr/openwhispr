const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(
  path.join(__dirname, "../../src/components/ControlPanel.tsx"),
  "utf8"
);
const start = source.indexOf("  const retryTranscription = useCallback(");
const end = source.indexOf("  const toggleShowDiscarded =", start);
assert.ok(start >= 0 && end > start);
const callback = ts.transpileModule(`${source.slice(start, end)}\nretryTranscription;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

async function setup(t, overrides = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () =>
        JSON.stringify([
          JSON.stringify(["transcriptionProviders", "openai", "future-published-stt"]),
        ]),
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  const availability = await import("../../src/models/registryModelAvailability.ts");
  const calls = [];
  const toasts = [];
  const settings = {
    transcriptionMode: "providers",
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "future-published-stt",
    ...overrides.settings,
  };
  const retry = vm.runInNewContext(callback, {
    ...availability,
    useCallback: (fn) => fn,
    useCleanupModel: false,
    getSettings: () => settings,
    getManagedTranscriptionResolution: () => overrides.managed ?? null,
    usePolicyStore: { getState: () => ({}) },
    isTranscriptionContextAllowed: () => overrides.policyAllowed !== false,
    toast: (options) => toasts.push(options),
    t: (key) => key,
    providerErrorToastProps: () => ({}),
    window: {
      electronAPI: {
        retryTranscription: async (...args) => {
          calls.push(args);
          return { success: false, error: "fixture ends after IPC" };
        },
      },
    },
  });
  return { retry, calls, toasts };
}

test("retry blocks a missing published model before invoking main-process IPC", async (t) => {
  const { retry, calls, toasts } = await setup(t);
  await retry(123);
  assert.equal(calls.length, 0);
  assert.equal(toasts[0].title, "onboarding.rehaul.provider.errors.modelNotFound");
});

test("retry policy denial outranks the missing published model", async (t) => {
  const { retry, calls, toasts } = await setup(t, { policyAllowed: false });
  await retry(123);
  assert.equal(calls.length, 0);
  assert.equal(toasts[0].title, "common.managedByOrg");
});

for (const [label, overrides] of [
  ["managed enterprise", { managed: { kind: "managed", provider: "azure" } }],
  [
    "managed cloud",
    { settings: { cloudTranscriptionMode: "openwhispr", transcriptionMode: "openwhispr" } },
  ],
  ["local", { settings: { useLocalWhisper: true, transcriptionMode: "local" } }],
  [
    "self-hosted",
    {
      settings: {
        transcriptionMode: "self-hosted",
        remoteTranscriptionUrl: "http://localhost:8000",
      },
    },
  ],
  ["ordinary legacy unknown", { settings: { cloudTranscriptionModel: "legacy-unknown" } }],
]) {
  test(`retry preserves the ${label} route`, async (t) => {
    const { retry, calls } = await setup(t, overrides);
    await retry(123);
    assert.equal(calls.length, 1);
  });
}

test("retry resumes the exact saved selection once its verified catalog returns", async (t) => {
  const { retry, calls } = await setup(t);
  const store = await import("../../src/models/registryData.js");
  const previous = store.getRegistrySnapshot();
  const data = structuredClone(previous.data);
  data.transcriptionProviders
    .find((provider) => provider.id === "openai")
    .models.push({
      id: "future-published-stt",
      name: "Future",
      description: "Future model",
    });
  store.replaceRegistryData({ data, manifestVersion: previous.manifestVersion + 1 });
  t.after(() =>
    store.replaceRegistryData({
      data: previous.data,
      manifestVersion: previous.manifestVersion + 2,
    })
  );
  await retry(123);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].cloudTranscriptionModel, "future-published-stt");
});
