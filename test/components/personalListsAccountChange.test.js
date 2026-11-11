const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

// The real settings store and Snippets page against a fake main process that
// keeps each account's lists and refuses a whole-list save named for another
// account, as main does. "Switch account" in the invitation modal changes the
// account in place, so the page can be open with an edit under way.

const MOCKS = {
  "react-i18next": `
    const t = (key, options) => (options ? key + JSON.stringify(options) : key);
    export const useTranslation = () => ({ t, i18n: { language: "en", dir: () => "ltr" } });
    export const initReactI18next = { type: "3rdParty", init() {} };
  `,
  "/hooks/useSettings": `
    import { useSettingsStore } from "/stores/settingsStore.ts";
    export function useSettings() {
      const snippets = useSettingsStore((state) => state.snippets);
      const setSnippets = useSettingsStore((state) => state.setSnippets);
      return { snippets, setSnippets };
    }
  `,
  "/ui/dialog": `
    import { createElement } from "react";
    const Pass = ({ children }) => createElement("div", null, children);
    export const Dialog = ({ open, children }) => (open ? createElement("div", { "data-dialog": "" }, children) : null);
    export const DialogContent = Pass;
    export const DialogHeader = Pass;
    export const DialogTitle = Pass;
    export const DialogDescription = Pass;
    export const DialogFooter = Pass;
  `,
  // A save starts a cloud sync; signed out of the cloud here, it has nothing to do.
  "/services/SyncService.js": `
    export const syncService = { canSync: () => false };
  `,
  "/DictionaryEmptyIllustration": `
    export default function DictionaryEmptyIllustration() { return null; }
  `,
};

const A_SNIPPETS = [{ trigger: "addr", replacement: "A's address" }];
const B_SNIPPETS = [{ trigger: "addr", replacement: "B's address" }];

function fakeMain() {
  const main = {
    activeAccount: "account-a",
    lists: { "account-a": [...A_SNIPPETS], "account-b": [...B_SNIPPETS] },
    snippetSaves: [],
    dictionaryChanges: [],
    scopeListeners: new Set(),
  };
  const scope = () => ({ accountId: main.activeAccount, visibleAccountId: main.activeAccount });
  main.api = {
    getOpenAIKey: async () => "",
    getDictionary: async () => ["Kubernetes"],
    applyDictionaryChanges: async (changes, owner) => {
      main.dictionaryChanges.push([changes, owner]);
      return { success: true, added: 0, removed: 0 };
    },
    getSnippets: async () => main.lists[main.activeAccount],
    setSnippets: async (snippets, owner) => {
      if (owner !== undefined && owner !== main.activeAccount)
        return { success: false, stale: true };
      main.snippetSaves.push([main.activeAccount, snippets]);
      main.lists[main.activeAccount] = snippets;
      return { success: true };
    },
    getDatabaseAccountScope: async () => scope(),
    onDatabaseAccountScopeChanged: (listener) => {
      main.scopeListeners.add(listener);
      return () => main.scopeListeners.delete(listener);
    },
  };
  // What main sends every window: the scope first, then that account's lists.
  main.rescope = async (store, accountId) => {
    const changed = accountId !== main.activeAccount;
    main.activeAccount = accountId;
    for (const listener of main.scopeListeners) listener(scope());
    if (changed) store.getState().applySnippetsFromExternal(main.lists[accountId]);
  };
  return main;
}

async function renderSnippets(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const main = fakeMain();
  installBrowserGlobals(t, {
    initialStorage: {
      snippets: JSON.stringify(A_SNIPPETS),
      customDictionary: '["Kubernetes"]',
      // Keeps startup from writing the agent name into the dictionary.
      agentName: "Kubernetes",
    },
    window: { electronAPI: main.api },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-personal-lists-account-change-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  // A save loads it on demand; loaded now, that load can't outlast the test.
  await vite.ssrLoadModule("/services/SyncService.js");
  try {
    await settings.initializeSettings();
  } finally {
    const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
    await i18n.changeLanguage("en");
  }
  // Startup's read of whose lists these are.
  await new Promise((resolve) => setImmediate(resolve));
  const { default: SnippetsView } = await vite.ssrLoadModule("/components/SnippetsView.tsx");
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(SnippetsView)));
  return { container, main, settings, store: settings.useSettingsStore };
}

const domEvent = (type, extra = {}) => ({
  type,
  bubbles: true,
  ...extra,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopPropagation() {
    this.cancelBubble = true;
  },
});
const click = (element) => React.act(async () => element.dispatchEvent(domEvent("click")));
const type = (element, value) =>
  React.act(async () => {
    element.type ??= "text";
    element.value = value;
    element.dispatchEvent(domEvent("input"));
  });
const byLabel = (container, label) =>
  findElement(container, (node) => node.getAttribute?.("aria-label") === label);
const byTag = (container, tagName) => findElement(container, (node) => node.tagName === tagName);
// React keeps an element's current props on the node; a handler read before
// the account change is the one an in-flight Save would still run.
const reactProps = (node) => node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))];
const flush = () => React.act(async () => new Promise((resolve) => setImmediate(resolve)));

async function openEditor(container) {
  await click(byLabel(container, 'dictionary.snippets.edit{"trigger":"addr"}'));
  const dialog = findElement(container, (node) => node.getAttribute?.("data-dialog") === "");
  assert.ok(dialog, "the edit dialog is open");
  await type(byTag(dialog, "TEXTAREA"), "A's new address");
  return byTag(dialog, "FORM");
}

test("an edit opened as A never overwrites B's snippet with the same trigger", async (t) => {
  const { container, main, store } = await renderSnippets(t);
  const form = await openEditor(container);
  const staleSubmit = reactProps(form).onSubmit;

  await React.act(async () => main.rescope(store, "account-b"));
  assert.equal(
    findElement(container, (node) => node.getAttribute?.("data-dialog") === ""),
    null,
    "the editor opened for A is closed"
  );

  // The Save that was already on its way when the account changed.
  await React.act(async () => staleSubmit(domEvent("submit")));
  await flush();

  assert.deepEqual(main.snippetSaves, [], "nothing was written");
  assert.deepEqual(main.lists["account-b"], B_SNIPPETS);
  assert.deepEqual(main.lists["account-a"], A_SNIPPETS);
  assert.deepEqual(store.getState().snippets, B_SNIPPETS);
});

test("a new snippet drafted as A isn't added to B's list", async (t) => {
  const { container, main, store } = await renderSnippets(t);
  const triggerInput = findElement(
    container,
    (node) =>
      node.tagName === "INPUT" &&
      node.getAttribute("placeholder") === "dictionary.snippets.addPlaceholder"
  );
  await type(triggerInput, "sig");
  await React.act(async () => triggerInput.dispatchEvent(domEvent("keydown", { key: "Enter" })));
  await type(byTag(container, "TEXTAREA"), "Best, A");
  const createButton = findElement(
    container,
    (node) => node.tagName === "BUTTON" && node.textContent === "dictionary.snippets.create"
  );
  const staleCreate = reactProps(createButton).onClick;

  await React.act(async () => main.rescope(store, "account-b"));
  assert.equal(byTag(container, "TEXTAREA"), null, "the draft panel is gone");
  await React.act(async () => staleCreate(domEvent("click")));
  await flush();

  assert.deepEqual(main.snippetSaves, []);
  assert.deepEqual(main.lists["account-b"], B_SNIPPETS);
});

test("a token rotation for the same account keeps the editor and its save", async (t) => {
  const { container, main, store } = await renderSnippets(t);
  const form = await openEditor(container);

  await React.act(async () => main.rescope(store, "account-a"));
  assert.ok(
    findElement(container, (node) => node.getAttribute?.("data-dialog") === ""),
    "the editor stays open"
  );
  await React.act(async () => form.dispatchEvent(domEvent("submit")));
  await flush();

  assert.deepEqual(main.snippetSaves, [
    ["account-a", [{ trigger: "addr", replacement: "A's new address" }]],
  ]);
});

test("a dictionary change opened under a replaced owner is refused by the store", async (t) => {
  const { main, settings, store } = await renderSnippets(t);
  const openedAs = settings.getListsOwnerRevision();

  store.getState().updateCustomDictionary({ add: ["Qdrant"] }, openedAs);
  await flush();
  assert.equal(main.dictionaryChanges.length, 1, "unchanged account: the change goes through");

  await React.act(async () => main.rescope(store, "account-b"));
  store.getState().updateCustomDictionary({ add: ["Tiptap"], remove: ["Qdrant"] }, openedAs);
  await flush();
  assert.equal(main.dictionaryChanges.length, 1, "the late rename never reaches main");
  assert.equal(store.getState().customDictionary.includes("Tiptap"), false);
});
