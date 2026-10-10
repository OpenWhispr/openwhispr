const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom } = require("../lib/settingsAuditHarness");
const { enterpriseProviderMocks } = require("../lib/enterpriseProviderFixture");

const translations = require("../../src/locales/en/translation.json");
const translate = (key) => {
  const value = key.split(".").reduce((object, part) => object?.[part], translations);
  assert.equal(typeof value, "string", `existing translation: ${key}`);
  return value;
};

// These checks use native labels/ARIA attributes, not a browser accessibility tree.
test("shared controls keep explicit names, native labels and multi-control actions distinct", async (t) => {
  const { dom, root, container } = await mountAuditDom(t);
  globalThis.__controlLabels = { t: translate };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-control-labels-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({t: globalThis.__controlLabels.t});`,
    },
  });
  const { SettingsRow } = await vite.ssrLoadModule("/components/ui/SettingsSection.tsx");
  const { Toggle } = await vite.ssrLoadModule("/components/ui/toggle.tsx");
  const { SettingsLayoutProvider } = await vite.ssrLoadModule(
    "/components/ui/useSettingsLayout.ts"
  );
  const { default: ApiKeyInput } = await vite.ssrLoadModule("/components/ui/ApiKeyInput.tsx");
  const { default: LanguageSelector } = await vite.ssrLoadModule(
    "/components/ui/LanguageSelector.tsx"
  );
  let switched = 0;
  let submitted = 0;
  const render = (label, compact = false) =>
    React.act(async () =>
      root.render(
        React.createElement(
          SettingsLayoutProvider,
          { value: { isCompact: compact } },
          React.createElement(
            "form",
            {
              onSubmit: (event) => {
                event.preventDefault();
                submitted++;
              },
              "data-compact": compact,
            },
            React.createElement(
              SettingsRow,
              { label, htmlFor: "choice" },
              React.createElement(
                "select",
                { id: "choice" },
                React.createElement("option", null, "One")
              ),
              React.createElement("button", { type: "button" }, "Save")
            ),
            React.createElement(Toggle, {
              checked: false,
              ariaLabel: label,
              onChange: () => switched++,
            }),
            React.createElement(Toggle, {
              checked: true,
              disabled: true,
              ariaLabel: "Disabled",
              onChange: () => switched++,
            }),
            React.createElement(ApiKeyInput, {
              apiKey: "",
              setApiKey() {},
              label: "Access Key ID",
            }),
            React.createElement(ApiKeyInput, {
              apiKey: "fake-secret",
              setApiKey() {},
              label: "Secret Access Key",
            }),
            React.createElement(LanguageSelector, {
              value: "en",
              onChange() {},
              ariaLabel: label,
              options: [{ value: "en", label: "English", flag: "" }],
            })
          )
        )
      )
    );
  await render("Language");
  const select = container.querySelector("select");
  assert.equal(select.labels[0].textContent, "Language");
  assert.equal(container.querySelector('button[type="button"]').textContent, "Save");
  const switches = container.querySelectorAll('[role="switch"]');
  assert.equal(switches[0].getAttribute("aria-label"), "Language");
  await React.act(async () => {
    switches[0].click();
    switches[1].click();
  });
  assert.equal(switched, 1);
  assert.equal(submitted, 0, "switches do not submit their containing form");
  assert.equal(switches[1].getAttribute("aria-checked"), "true");
  const keyButtons = [...container.querySelectorAll("button")].filter((button) =>
    button.getAttribute("aria-label")?.includes("API key")
  );
  assert.match(keyButtons[0].getAttribute("aria-label"), /Access Key ID/);
  assert.match(keyButtons[1].getAttribute("aria-label"), /Secret Access Key/);
  assert.notEqual(keyButtons[0].id, keyButtons[1].id);
  await React.act(async () => keyButtons[0].click());
  const input = container.querySelector("input");
  assert.equal(input.labels[0].textContent, "Access Key ID");
  assert.equal(input.getAttribute("aria-label"), "Access Key ID");
  await React.act(async () =>
    input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  );
  assert.equal(container.querySelector("input"), null);
  await render("Langue", true);
  assert.equal(select.labels[0].textContent, "Langue");
  assert.ok(select.closest(".flex-col"), "compact rows retain the stacked layout");
  assert.equal(switches[0].getAttribute("aria-label"), "Langue");
  assert.equal(
    container.querySelector('[aria-haspopup="listbox"]').getAttribute("aria-label"),
    "Langue"
  );
});

test("Enterprise and GPU names distinguish fields and retained instances", async (t) => {
  const { root, container } = await mountAuditDom(t);
  globalThis.__controlLabels = { t: translate };
  globalThis.window.electronAPI = {
    listGpus: async () => [
      { index: 0, uuid: "GPU-one", name: "One", vramMb: 8192 },
      { index: 1, uuid: "GPU-two", name: "Two", vramMb: 8192 },
    ],
    getGpuDeviceIndex: async () => "GPU-two",
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-labels-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({t: globalThis.__controlLabels.t});`,
      ...enterpriseProviderMocks("__controlLabels.store", {
        providers: ["bedrock", "azure", "vertex"],
      }),
      "/ui/ModelCardList": `export default function Stub() { return null; }`,
      "/ui/SearchableModelList": `export default function Stub() { return null; }`,
      "/TestConnectionButton": `export default function Stub() { return null; }`,
    },
  });
  const { default: Enterprise } = await vite.ssrLoadModule(
    "/components/EnterpriseProviderConfig.tsx"
  );
  const { default: Gpu } = await vite.ssrLoadModule("/components/settings/GpuDeviceSelector.tsx");
  await React.act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        ...["bedrock", "azure", "vertex", "bedrock"].map((provider, index) =>
          React.createElement(
            "div",
            { key: index, hidden: index === 3 },
            React.createElement(Enterprise, {
              provider,
              reasoningModel: "model",
              setReasoningModel() {},
            })
          )
        ),
        React.createElement(Gpu, { purpose: "transcription" }),
        React.createElement(Gpu, { purpose: "intelligence" })
      )
    )
  );
  const ids = [...container.querySelectorAll("[id]")].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, "retained copies use unique IDs");
  for (const input of container.querySelectorAll("input"))
    assert.ok(input.getAttribute("aria-label") || input.labels.length);
  for (const select of container.querySelectorAll("select"))
    assert.ok(select.getAttribute("aria-label") || select.labels.length);
  const access = container.querySelector('button[aria-label^="Access Key ID:"]');
  await React.act(async () => access.click());
  assert.equal(
    container.querySelector('input[aria-label="Access Key ID"]').labels[0].textContent.trim(),
    "Access Key ID"
  );
  await React.act(async () =>
    globalThis.__controlLabels.store.setState({ bedrockAuthMode: "sso" })
  );
  assert.ok(
    [...container.querySelectorAll("input")].some(
      (input) => input.labels[0]?.textContent.trim() === "Profile Name"
    )
  );
  assert.equal(container.querySelector('select[aria-label="Transcription GPU"]').value, "GPU-two");
  assert.equal(container.querySelector('select[aria-label="Intelligence GPU"]').value, "GPU-two");
});

test("GPU StrictMode reads keep the saved purpose and debug readers ignore superseded replies", async (t) => {
  const { root, container } = await mountAuditDom(t);
  const observed = (globalThis.__controlLabels = { t: translate, toasts: [] });
  const gpuReads = [];
  const debugReads = [];
  const pending = (queue) => new Promise((resolve, reject) => queue.push({ resolve, reject }));
  globalThis.window.electronAPI = {
    listGpus: async () => [
      { index: 0, uuid: "GPU-one", name: "One", vramMb: 8192 },
      { index: 1, uuid: "GPU-two", name: "Two", vramMb: 8192 },
    ],
    getGpuDeviceIndex: () => pending(gpuReads),
    setGpuDeviceIndex: async () => ({ success: true }),
    getDebugState: () => pending(debugReads),
    setDebugLogging: async () => ({ success: true }),
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-device-readers-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({t: globalThis.__controlLabels.t});`,
      "/ui/useToast": `const toast = value => globalThis.__controlLabels.toasts.push(value); export const useToast = () => ({ toast });`,
    },
  });
  const { default: Gpu } = await vite.ssrLoadModule("/components/settings/GpuDeviceSelector.tsx");
  const { default: Developer } = await vite.ssrLoadModule("/components/DeveloperSection.tsx");
  const renderGpu = (purpose) =>
    React.act(async () =>
      root.render(
        React.createElement(React.StrictMode, null, React.createElement(Gpu, { purpose }))
      )
    );
  await renderGpu("transcription");
  assert.equal(gpuReads.length, 2);
  await renderGpu("intelligence");
  await React.act(async () => gpuReads[2].resolve("GPU-two"));
  await React.act(async () => {
    gpuReads[0].resolve("GPU-one");
    gpuReads[1].resolve("GPU-one");
  });
  assert.equal(container.querySelector("select").getAttribute("aria-label"), "Intelligence GPU");
  assert.equal(container.querySelector("select").value, "GPU-two");
  await React.act(async () =>
    root.render(React.createElement(React.StrictMode, null, React.createElement(Developer)))
  );
  assert.equal(debugReads.length, 2);
  await React.act(async () => debugReads[1].resolve({ enabled: true, logPath: "/fresh-log" }));
  await React.act(async () => debugReads[0].reject(new Error("obsolete")));
  const debugToggle = () => container.querySelector('[role="switch"]');
  assert.equal(debugToggle().getAttribute("aria-checked"), "true");
  assert.equal(debugToggle().disabled, false);
  assert.ok(container.textContent.includes("/fresh-log"));
  assert.equal(observed.toasts.length, 0);
  await React.act(async () => debugToggle().click());
  await React.act(async () => debugReads[2].resolve({ enabled: false, logPath: "/latest-log" }));
  assert.equal(debugToggle().getAttribute("aria-checked"), "false");
});

test("Workspace list refreshes keep the newest roster, teams and key metadata", async (t) => {
  const { root, container } = await mountAuditDom(t);
  const lists = { keys: [], teams: [], invites: [] };
  globalThis.__controlLabels = {
    t: (key) => key,
    pending: (kind) => new Promise((resolve, reject) => lists[kind].push({ resolve, reject })),
  };
  const stub = `export default function Stub() { return null; }`;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-list-readers-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({t: globalThis.__controlLabels.t, i18n: {language: "en"}});`,
      "/services/WorkspaceApiKeysService": `export const WorkspaceApiKeysService = { list: () => globalThis.__controlLabels.pending("keys") };`,
      "/services/TeamsService": `export const TeamsService = { list: () => globalThis.__controlLabels.pending("teams") };`,
      "/services/InvitationsService": `export const InvitationsService = { list: () => globalThis.__controlLabels.pending("invites") };`,
      "/services/WorkspacesService": `export const WorkspacesService = { listJoinRequests: async () => [] };`,
      "/services/spaceActions": `export const deleteTeam = async () => {};`,
      "/stores/noteStore": `export const useSpaces = () => []; export const loadSpaces = async () => {};`,
      "/stores/workspaceStore": `const state = { membersByWorkspace: {}, refreshMembers: async () => {}, refresh: async () => {} }; export const EMPTY_WORKSPACE_MEMBERS = []; export const useWorkspaceStore = select => select(state);`,
      "/hooks/useDialogs": `export const useDialogs = () => ({ confirmDialog: {}, showConfirmDialog() {}, hideConfirmDialog() {} });`,
      "/ui/useToast": `export const useToast = () => ({ toast() {} });`,
      "/ui/dialog": `export const ConfirmDialog = () => null; export const Dialog = ConfirmDialog; export const DialogContent = ConfirmDialog; export const DialogHeader = ConfirmDialog; export const DialogTitle = ConfirmDialog; export const DialogDescription = ConfirmDialog; export const DialogFooter = ConfirmDialog;`,
      "/CreateTeamDialog": stub,
      "/TeamMembersDialog": stub,
      "/InviteTeammateDialog": stub,
    },
  });
  for (const [kind, module] of [
    ["keys", "WorkspaceDeveloperTab"],
    ["teams", "WorkspaceTeamsTab"],
    ["invites", "WorkspaceMembersTab"],
  ]) {
    const { default: Component } = await vite.ssrLoadModule(`/components/settings/${module}.tsx`);
    const render = (id) =>
      React.act(async () =>
        root.render(
          React.createElement(Component, { key: id, workspace: { id, name: id, role: "owner" } })
        )
      );
    await render("one");
    await React.act(async () => lists[kind][0].reject(new Error("unavailable")));
    const retry = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("settingsPage.workspace.loadError.retry")
    );
    assert.ok(retry, kind);
    await React.act(async () => {
      retry.click();
      retry.click();
    });
    const row = (name) => [
      {
        id: name,
        name,
        email: name + "@example.com",
        key_prefix: name,
        status: "pending",
        expires_at: "2030-01-01",
      },
    ];
    await React.act(async () => lists[kind][2].resolve(row("current")));
    await React.act(async () => lists[kind][1].resolve(row("obsolete")));
    assert.ok(container.textContent.includes("current"), kind);
    assert.equal(container.textContent.includes("obsolete"), false, kind);
    await render("two");
    await render("three");
    await React.act(async () => lists[kind][4].resolve(row("new-workspace")));
    await React.act(async () => lists[kind][3].resolve(row("old-workspace")));
    assert.ok(container.textContent.includes("new-workspace"), kind);
    assert.equal(container.textContent.includes("old-workspace"), false, kind);
  }
});

test("small Settings controls use current commands, platform and keyboard selection", async (t) => {
  const { dom, container, render } = await mountAuditDom(t);
  const copied = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text) => copied.push(text) } },
  });
  let platform = "linux";
  dom.electronAPI = { getPlatform: () => platform };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-small-actions-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
    },
  });
  const { CopyableCommand } = await vite.ssrLoadModule("/components/ui/CopyableCommand.tsx");
  const { default: Warning } = await vite.ssrLoadModule("/components/ui/MicPermissionWarning.tsx");
  const { default: Language } = await vite.ssrLoadModule("/components/ui/LanguageSelector.tsx");
  const feedbackTimers = [];
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay !== 2000) return originalTimeout(callback, delay, ...args);
    feedbackTimers.push(callback);
    return 1;
  });
  const callbacks = [];
  await render(
    React.createElement(CopyableCommand, {
      command: "first",
      onCopied: () => callbacks.push("first"),
    })
  );
  assert.equal(container.querySelector("button").getAttribute("aria-label"), "common.copy");
  await React.act(async () => container.querySelector("button").click());
  assert.equal(container.querySelector("button").getAttribute("aria-label"), "common.copied");
  await React.act(async () => feedbackTimers.splice(0).forEach((callback) => callback()));
  await render(
    React.createElement(CopyableCommand, {
      command: "second",
      copyLabel: "Copy MCP URL",
      onCopied: () => callbacks.push("second"),
    })
  );
  assert.equal(container.querySelector("button").getAttribute("aria-label"), "Copy MCP URL");
  await React.act(async () => container.querySelector("button").click());
  assert.deepEqual(copied, ["first", "second"]);
  assert.deepEqual(callbacks, ["first", "second"]);
  assert.equal(container.querySelector("button").getAttribute("aria-label"), "common.copied");
  await React.act(async () => feedbackTimers.splice(0).forEach((callback) => callback()));
  assert.equal(container.querySelector("button").getAttribute("aria-label"), "Copy MCP URL");
  let sound = 0;
  let privacy = 0;
  for (platform of ["linux", "darwin", "win32"]) {
    await render(
      React.createElement(Warning, {
        error: null,
        onOpenSoundSettings: () => sound++,
        onOpenPrivacySettings: () => privacy++,
      })
    );
    const buttons = container.querySelectorAll("button");
    assert.equal(buttons.length, platform === "linux" ? 1 : 2);
    await React.act(async () => {
      for (const button of buttons) button.click();
    });
  }
  assert.deepEqual([sound, privacy], [3, 2]);
  const selected = [];
  await render(
    React.createElement(Language, {
      value: "en",
      onChange: (value) => selected.push(value),
      options: [
        { value: "en", label: "English", flag: "" },
        { value: "fr", label: "French", flag: "" },
      ],
    })
  );
  const trigger = container.querySelector('button[aria-haspopup="listbox"]');
  const key = (value) =>
    React.act(async () =>
      trigger.dispatchEvent(new dom.KeyboardEvent("keydown", { key: value, bubbles: true }))
    );
  await key("Enter");
  await key("ArrowDown");
  await key("Escape");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  await key("Enter");
  await key("Enter");
  assert.deepEqual(selected, ["en"], "Escape resets the highlighted index before reopening");
});
