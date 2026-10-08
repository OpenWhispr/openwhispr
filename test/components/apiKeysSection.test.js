const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");

const { createElement } = React;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

// The create dialog renders as a marker while open; the list comes from __apiKeys.
const MOCKS = {
  "react-i18next": `
    const t = (key) => key;
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
  `,
  "/services/ApiKeysService": `
    export const ApiKeysService = {
      list: () => globalThis.__apiKeysList(),
      revoke: async () => {},
      create: async () => ({}),
    };
  `,
  "/ui/dialog": `
    import React from "react";
    export const Dialog = ({ open, children }) =>
      open ? React.createElement("div", null, "CREATE DIALOG", children) : null;
    const Pass = ({ children }) => React.createElement("div", null, children);
    export const DialogContent = Pass;
    export const DialogHeader = Pass;
    export const DialogTitle = Pass;
    export const DialogDescription = Pass;
    export const DialogFooter = Pass;
    export const ConfirmDialog = () => null;
  `,
  "/ui/select": `
    import React from "react";
    const Pass = ({ children }) => React.createElement("div", null, children);
    export const Select = Pass;
    export const SelectContent = Pass;
    export const SelectTrigger = Pass;
    export const SelectValue = () => null;
    export const SelectItem = Pass;
  `,
  "/ui/useToast": `
    export const useToast = () => ({ toast() {} });
  `,
};

const keysOf = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `key-${index}`,
    name: `Key ${index}`,
    key_prefix: `ow_${index}`,
    scopes: [],
    last_used_at: null,
  }));

async function renderSection(t, { keyCount = 0 } = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  let resolveList;
  globalThis.__apiKeysList = () =>
    new Promise((resolve) => {
      resolveList = () => resolve({ keys: keysOf(keyCount) });
    });
  t.after(() => delete globalThis.__apiKeysList);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-api-keys-section-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { default: ApiKeysSection } = await vite.ssrLoadModule("/components/ApiKeysSection.tsx");
  root = createRoot(container);
  const render = (createRequest) =>
    React.act(async () => root.render(createElement(ApiKeysSection, { createRequest })));
  return { container, render, loadKeys: () => React.act(async () => resolveList()) };
}

test("a create request opens the create dialog once the keys have loaded", async (t) => {
  const { container, render, loadKeys } = await renderSection(t, { keyCount: 1 });
  await render(1);
  assert.doesNotMatch(container.textContent, /CREATE DIALOG/);

  await loadKeys();
  assert.match(container.textContent, /CREATE DIALOG/);
});

test("without a create request, the dialog stays closed", async (t) => {
  const { container, render, loadKeys } = await renderSection(t, { keyCount: 1 });
  await render(0);
  await loadKeys();
  assert.doesNotMatch(container.textContent, /CREATE DIALOG/);
});

test("at the key limit a create request opens nothing, and the list says why", async (t) => {
  const { container, render, loadKeys } = await renderSection(t, { keyCount: 5 });
  await render(1);
  await loadKeys();
  assert.doesNotMatch(container.textContent, /CREATE DIALOG/);
  assert.match(container.textContent, /apiKeysSection\.maxKeysReached/);
});
