const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom } = require("../lib/settingsAuditHarness");

const en = require("../../src/locales/en/translation.json");
const fr = require("../../src/locales/fr/translation.json");
function translate(dict, key, params = {}) {
  return String(key.split(".").reduce((s, k) => s?.[k], dict) ?? key).replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => params[key] ?? ""
  );
}

test("real model cards expose native named selections and isolated sibling actions in both locales", async (t) => {
  const { dom, root, container, render } = await mountAuditDom(t);
  globalThis.__cardT = (key, params) => translate(en, key, params);
  t.after(() => delete globalThis.__cardT);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({t: globalThis.__cardT});`,
    },
  });
  const { ModelCard } = await vite.ssrLoadModule("/components/ui/ModelCardList.tsx");
  const calls = [];
  dom.electronAPI = { openExternal: (url) => calls.push(["link", url]) };
  const card = (model, local = true) =>
    React.createElement(ModelCard, {
      key: model.value,
      model,
      isSelected: model.value === "active",
      onSelect: (id) => calls.push(["select", id]),
      ...(local
        ? {
            onDownload: (id) => calls.push(["download", id]),
            onDelete: (id) => calls.push(["delete", id]),
            onCancelDownload: (id) => calls.push(["cancel", id]),
          }
        : {}),
    });
  const models = [
    { value: "active", label: "Active", isDownloaded: true, specUrl: "https://example.test/spec" },
    { value: "installed", label: "Installed", isDownloaded: true },
    { value: "missing", label: "Missing" },
    { value: "pending", label: "Pending", isDownloading: true, isCancelling: true },
  ];
  const draw = () =>
    render(
      React.createElement(
        React.Fragment,
        null,
        ...models.map((m) => card(m)),
        card({ value: "cloud", label: "Cloud" }, false)
      )
    );
  await draw();
  const selection = (name) => container.querySelector(`button[aria-label="${name}"]`);
  assert.equal(container.querySelector("button button, button a"), null);
  for (const name of ["Active", "Installed", "Cloud"]) {
    assert.equal(selection(name).type, "button");
  }
  assert.equal(selection("Active").getAttribute("aria-pressed"), "true");
  assert.equal(selection("Installed").getAttribute("aria-pressed"), "false");
  assert.equal(selection("Missing").disabled, true);
  assert.equal(selection("Pending").disabled, true);
  await React.act(async () => selection("Installed").click());
  assert.deepEqual(calls, [["select", "installed"]]);
  const deleteButton = (name) => {
    const card = [...container.querySelectorAll("div.group")].find((c) =>
      c.querySelector(`button[aria-label="${name}"]`)
    );
    return [...card.querySelectorAll("button")].find((b) =>
      b.className.includes("group-focus-within:opacity-100")
    );
  };
  await React.act(async () => deleteButton("Installed").click());
  await React.act(async () =>
    [...container.querySelectorAll("button")]
      .find((b) => b.textContent.trim() === "Download")
      .click()
  );
  assert.deepEqual(calls.slice(1), [
    ["delete", "installed"],
    ["download", "missing"],
  ]);
  assert.equal(
    [...container.querySelectorAll("button")].find((b) => b.textContent === "...").disabled,
    true
  );
  assert.ok(container.querySelector("a[href]"));
  globalThis.__cardT = (key, params) => translate(fr, key, params);
  await draw();
  assert.ok(deleteButton("Installed"), "delete control survives a locale change");
  await React.act(async () => root.unmount());
});

test("real ASR picker cards keep downloaded-only selection and disabled cancellation", async (t) => {
  const { dom, container, render } = await mountAuditDom(t);
  const calls = [];
  globalThis.__asrCalls = calls;
  t.after(() => delete globalThis.__asrCalls);
  dom.electronAPI = {
    getPlatform: () => "darwin",
    checkParakeetInstallation: async () => ({ supported: true }),
    listWhisperModels: async () => ({
      success: true,
      models: [
        { model: "tiny", downloaded: true },
        { model: "base", downloaded: true },
        { model: "small", downloaded: false },
      ],
    }),
  };
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({t: (key) => key});`,
      "/stores/settingsStore": `export const useSettingsStore = fn => fn({});`,
      "/hooks/usePolicy": `export const usePolicySnapshot = () => ({status:"unmanaged"});`,
      "/hooks/useModelDownload": `export const useModelDownload = () => ({ downloads: {}, downloadModel() {}, deleteModel() {}, cancelDownload() {}, isDownloadingModel: id => id === "small", isCancellingModel: id => id === "small" });`,
      "/hooks/useDialogs": `export const useDialogs = () => ({confirmDialog: {}, showConfirmDialog: () => globalThis.__asrCalls.push("confirm"), hideConfirmDialog() {}});`,
      "/ui/dialog": `export const ConfirmDialog = () => null;`,
    },
  });
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  await render(
    React.createElement(Picker, {
      mode: "local",
      useLocalWhisper: true,
      selectedLocalModel: "tiny",
      selectedLocalProvider: "whisper",
      selectedCloudProvider: "openai",
      selectedCloudModel: "",
      onCloudProviderSelect() {},
      onCloudModelSelect() {},
      onModeChange() {},
      onLocalModelSelect: (id, provider) => calls.push([id, provider]),
    })
  );
  const selections = [...container.querySelectorAll("button[aria-pressed]")].filter((b) =>
    b.className.includes("absolute inset-0")
  );
  assert.equal(selections.length, 3);
  assert.equal(selections[0].getAttribute("aria-pressed"), "true");
  assert.equal(selections[1].disabled, false);
  assert.equal(selections[2].disabled, true);
  await React.act(async () => selections[1].click());
  assert.deepEqual(calls, [["base", "whisper"]]);
  await React.act(async () =>
    [...container.querySelectorAll("button")]
      .find((b) => b.className.includes("group-focus-within:opacity-100"))
      .click()
  );
  assert.equal(calls.at(-1), "confirm", "delete opens consent, not selection or native deletion");
  assert.equal(container.querySelector("button button, button a"), null);
  assert.equal(
    [...container.querySelectorAll("button")].find((b) => b.textContent === "...").disabled,
    true
  );
});
