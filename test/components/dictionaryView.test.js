const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { createElement } = React;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

const ENGINEERING = "11111111-1111-4111-8111-111111111111";
const SALES = "22222222-2222-4222-8222-222222222222";

const MOCKS = {
  "react-i18next": `
    const t = (key, options) => (options ? key + JSON.stringify(options) : key);
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
  `,
  "/hooks/useSettings": `
    export function useSettings() { return globalThis.__settings; }
  `,
  "/hooks/useWorkspace": `
    export function useWorkspace() {
      const active = globalThis.__workspace;
      return { active, role: active?.role ?? null, workspaces: active ? [active] : [] };
    }
  `,
  "/hooks/useAuth": `
    export function useAuth() {
      const isSignedIn = globalThis.__signedIn ?? true;
      return { isSignedIn, user: isSignedIn ? { id: "u-me" } : null };
    }
  `,
  "/utils/agentName": `
    export const getAgentName = () => "Whispr";
  `,
  "/stores/sharedDictionaryStore": `
    export function useSharedDictionaryStore(selector) { return selector(globalThis.__shared); }
    useSharedDictionaryStore.getState = () => globalThis.__shared;
  `,
  "/services/sharedDictionaryActions": `
    export class SharedDictionaryActionError extends Error {
      constructor(reason) {
        super(reason);
        this.reason = reason;
        this.appliedCount = 0;
      }
    }
    // For results that fail part-way: build one, set appliedCount (and undo), throw it.
    globalThis.__ActionError = SharedDictionaryActionError;
    // A result of "throw:<reason>" makes the call fail with that reason; a
    // function result is called with the arguments and gives the result.
    const record = (name) => async (...args) => {
      globalThis.__calls.push([name, ...args]);
      const stored = globalThis.__results?.[name];
      const result = typeof stored === "function" ? await stored(...args) : stored;
      if (typeof result === "string" && result.startsWith("throw:")) {
        throw new SharedDictionaryActionError(result.slice("throw:".length));
      }
      return result;
    };
    export const addSharedWords = record("addSharedWords");
    export const editSharedWord = record("editSharedWord");
    export const deleteSharedWords = record("deleteSharedWords");
    export const setSharedWordsHidden = record("setSharedWordsHidden");
    export const sharePersonalWords = record("sharePersonalWords");
  `,
  "/services/SyncService": `
    export const syncService = {
      syncSharedDictionaryNow: async () => {
        globalThis.__calls.push(["syncShared"]);
        if (globalThis.__results?.syncShared === "reject") throw new Error("offline");
      },
      syncDictionaryNow: async () => { globalThis.__calls.push(["syncPersonal"]); },
    };
  `,
  "/utils/logger": `
    const record = (level) => (...args) => { globalThis.__calls.push(["log:" + level, ...args]); };
    export default { warn: record("warn"), error: record("error"), info: record("info"), debug: record("debug") };
  `,
  "/ui/dropdown-menu": `
    import { createElement } from "react";
    export const DropdownMenu = ({ children }) => children;
    export const DropdownMenuTrigger = ({ children }) => children;
    export const DropdownMenuContent = ({ children }) => createElement("div", null, children);
    export const DropdownMenuItem = ({ children, onSelect }) =>
      createElement("button", { onClick: onSelect, "data-menu-item": "" }, children);
    export const DropdownMenuSeparator = () => null;
  `,
  // Radix Tabs and Dialog measure styles this DOM doesn't implement.
  "/ui/tabs": `
    import { createElement } from "react";
    const Pass = ({ children }) => createElement("div", null, children);
    export const Tabs = ({ children, value, onValueChange }) => {
      globalThis.__tabs = { value, onValueChange };
      return createElement("div", null, children);
    };
    export const TabsList = Pass;
    export const TabsTrigger = ({ children, value }) =>
      createElement(
        "button",
        { "data-tab": value, onClick: () => globalThis.__tabs.onValueChange(value) },
        children
      );
    export const TabsContent = ({ children, value }) =>
      value === globalThis.__tabs?.value ? createElement("div", null, children) : null;
  `,
  "/ui/dialog": `
    import { createElement } from "react";
    export const ConfirmDialog = ({ open, title, onConfirm, onOpenChange, confirmText, cancelText }) =>
      open
        ? createElement(
            "div",
            { "data-dialog": title, "data-confirm-text": confirmText, "data-cancel-text": cancelText },
            createElement("button", {
              "data-confirm": "",
              onClick: () => {
                onConfirm();
                onOpenChange(false);
              },
            }),
            createElement("button", { "data-cancel": "", onClick: () => onOpenChange(false) })
          )
        : null;
  `,
  // Radix positions the content with layout this DOM doesn't implement.
  "/ui/popover": `
    import { createElement } from "react";
    export const Popover = ({ open, children }) => (open ? children : null);
    export const PopoverAnchor = () => null;
    export const PopoverContent = ({ children }) => createElement("div", { "data-popover": "" }, children);
  `,
  "/ui/useToast": `
    export const useToast = () => ({ toast: (props) => { globalThis.__toasts.push(props); return "id"; } });
  `,
  "/SnippetsView": `
    export default function SnippetsView() { return null; }
  `,
  "/DictionaryEmptyIllustration": `
    export default function DictionaryEmptyIllustration() { return null; }
  `,
};

const entry = (cloudId, word, spaceId, addedByUserId = "u-ana", createdAt = "2026-10-01") => ({
  cloudId,
  spaceId,
  word,
  addedByUserId,
  createdAt: `${createdAt}T00:00:00.000Z`,
  updatedAt: `${createdAt}T00:00:00.000Z`,
});

const SNAPSHOT = {
  entries: [
    entry("e-arr", "ARR", null),
    entry("e-k8s", "Kubernetes", null),
    entry("e-qdrant", "Qdrant", ENGINEERING),
    entry("e-sherpa", "sherpa-onnx", ENGINEERING, "u-me"),
    entry("e-meddicc", "MEDDICC", SALES),
  ],
  hiddenIds: [],
  meta: {
    scopes: [
      { space_id: null, name: "Acme", member_count: 20, word_count: 2 },
      { space_id: ENGINEERING, name: "Engineering", member_count: 14, word_count: 2 },
      { space_id: SALES, name: "Sales", member_count: 5, word_count: 1 },
    ],
    contributors: [{ user_id: "u-ana", name: "Ana", is_member: true }],
    paused: false,
    syncedAt: "2026-10-20T10:00:00.000Z",
  },
};

function setState(t, { initialStorage = {}, shared = {}, settings = {} } = {}) {
  const calls = [];
  globalThis.__calls = calls;
  globalThis.__toasts = [];
  globalThis.__results = { deleteSharedWords: { undo: async () => {} } };
  globalThis.__settings = {
    customDictionary: ["OpenWhispr", "Supabase", "Whispr"],
    updateCustomDictionary: (changes) => calls.push(["updateCustomDictionary", changes]),
    snippets: [],
    ...settings,
  };
  globalThis.__workspace = {
    id: "ws",
    name: "Acme",
    plan: "business",
    status: "active",
    role: "member",
  };
  globalThis.__shared = {
    workspaceId: "ws",
    status: "ready",
    snapshot: SNAPSHOT,
    movedPersonal: [],
    syncing: false,
    lastSyncedAt: SNAPSHOT.meta.syncedAt,
    requestedList: null,
    setRequestedList: (list) => {
      globalThis.__shared.requestedList = list;
    },
    reload: async () => {
      calls.push(["reload"]);
    },
    generation: 0,
    markSynced: (generation) => calls.push(["markSynced", generation]),
    ...shared,
  };
  t.after(() => {
    for (const key of [
      "__calls",
      "__toasts",
      "__results",
      "__settings",
      "__workspace",
      "__shared",
      "__tabs",
      "__signedIn",
      "__ActionError",
    ]) {
      delete globalThis[key];
    }
  });
  return { calls, initialStorage };
}

async function renderView(t, options = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const { calls, initialStorage } = setState(t, options);
  const exported = [];
  const syncListeners = new Set();
  const electronAPI = {
    exportDictionary: async (words) => {
      exported.push(words);
      return {};
    },
    onSyncEvent: (listener) => {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
  };
  const { storage } = installBrowserGlobals(t, { initialStorage, window: { electronAPI } });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictionary-view-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { default: DictionaryView } = await vite.ssrLoadModule("/components/DictionaryView.tsx");
  // Loaded after the DOM is installed, so react-dom detects native input events.
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  const rerender = () =>
    React.act(async () =>
      root.render(createElement(DictionaryView, { onUpgrade: () => calls.push(["upgrade"]) }))
    );
  await rerender();
  const emitSyncEvent = (event) => {
    for (const listener of syncListeners) listener(event);
  };
  return { container, calls, storage, exported, rerender, emitSyncEvent };
}

const click = (element) =>
  React.act(async () => element.dispatchEvent({ type: "click", bubbles: true }));

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

// React's change event reads the new value from the element, then an input event.
// It only treats an <input> as text when its type property says so, which this
// DOM leaves unset for an input rendered without a type.
const type = (element, value) =>
  React.act(async () => {
    element.type ??= "text";
    element.value = value;
    element.dispatchEvent(domEvent("input"));
  });

const pressEnter = (element) =>
  React.act(async () => element.dispatchEvent(domEvent("keydown", { key: "Enter" })));

const addInput = (container) =>
  findElement(
    container,
    (node) =>
      node.tagName === "INPUT" &&
      node.getAttribute("placeholder") === "dictionary.shared.add.placeholder"
  );

const byAttribute = (container, name, value = "") =>
  findElement(container, (node) => node.getAttribute?.(name) === value);

const pickerEntry = (container, key) =>
  findElement(container, (node) => node.getAttribute?.("data-list-key") === key);

const rowFor = (container, word) =>
  findElement(
    container,
    (node) => node.tagName === "LI" && node.getAttribute("data-word") === word
  );

const buttonsIn = (node) => node.querySelectorAll("button");

const openList = async (container, key) => {
  const button = pickerEntry(container, key);
  assert.ok(button, `picker entry ${key} exists`);
  await click(button);
};

test("renders picker entries with counts", async (t) => {
  const { container, calls } = await renderView(t);
  const expected = {
    all: ["dictionary.shared.allWords", "7"],
    personal: ["dictionary.shared.personal", "2"],
    allShared: ["dictionary.shared.allShared", "5"],
    workspace: ['dictionary.shared.everyoneAt{"workspace":"Acme"}', "2"],
    [`space:${ENGINEERING}`]: ["Engineering", "2"],
    [`space:${SALES}`]: ["Sales", "1"],
    hidden: ["dictionary.shared.hidden", "0"],
  };
  for (const [key, [label, count]] of Object.entries(expected)) {
    const button = pickerEntry(container, key);
    assert.ok(button, `picker entry ${key} exists`);
    assert.equal(button.textContent, `${label}${count}`);
  }
  assert.ok(container.textContent.includes("dictionary.shared.group"));
  // The page's snapshot is reread on mount: another window may have run the last pass.
  assert.ok(calls.some(([name]) => name === "reload"));
});

test("without the shared dictionary the page is Personal alone, with Clear all and Export", async (t) => {
  const { container } = await renderView(t, { shared: { status: "unavailable" } });
  // All words would only repeat Personal, so there is no picker at all.
  assert.equal(pickerEntry(container, "all"), null);
  assert.equal(pickerEntry(container, "allShared"), null);
  assert.ok(!container.textContent.includes("dictionary.shared.group"));
  assert.ok(container.textContent.includes("dictionary.shared.personal · 2"));
  assert.ok(rowFor(container, "OpenWhispr"));
  assert.equal(rowFor(container, "ARR"), null);
  assert.ok(byAttribute(container, "aria-label", "dictionary.clearAll"));
  assert.ok(byAttribute(container, "aria-label", "dictionary.exportDictionary"));
});

test("mixed view shows list badges", async (t) => {
  const { container } = await renderView(t);
  await openList(container, "allShared");
  assert.match(rowFor(container, "Qdrant").textContent, /^QdrantEngineering/);
  assert.match(rowFor(container, "ARR").textContent, /^ARRAcme/);
  assert.match(rowFor(container, "MEDDICC").textContent, /^MEDDICCSales/);

  // A single list shows who added each word instead.
  await openList(container, `space:${ENGINEERING}`);
  assert.match(rowFor(container, "Qdrant").textContent, /^QdrantAna/);
  assert.match(
    rowFor(container, "sherpa-onnx").textContent,
    /dictionary\.shared\.attribution\.you/
  );
});

const ariaLabels = (row) => buttonsIn(row).map((button) => button.getAttribute("aria-label"));
const named = (key, word) => `${key}{"word":"${word}"}`;

test("shared row hover exposes Edit, Hide for me and Delete for everyone by aria-label", async (t) => {
  const { container, calls } = await renderView(t);
  await openList(container, `space:${ENGINEERING}`);
  // The tooltip is the short action; the accessible name says which word.
  assert.deepEqual(ariaLabels(rowFor(container, "Qdrant")), [
    named("dictionary.shared.selection.selectWord", "Qdrant"),
    named("dictionary.editWord", "Qdrant"),
    named("dictionary.shared.actions.hideWord", "Qdrant"),
    named("dictionary.shared.actions.deleteForEveryoneWord", "Qdrant"),
  ]);

  await click(buttonsIn(rowFor(container, "Qdrant"))[2]);
  assert.deepEqual(
    calls.find(([name]) => name === "setSharedWordsHidden"),
    ["setSharedWordsHidden", "ws", ["e-qdrant"], true]
  );
});

test("Delete for everyone runs only after confirming, then offers Undo", async (t) => {
  const { container, calls } = await renderView(t);
  await openList(container, `space:${ENGINEERING}`);
  const deleteButton = () => buttonsIn(rowFor(container, "Qdrant"))[3];
  const dialog = () =>
    findElement(container, (node) =>
      node.getAttribute?.("data-dialog")?.includes("deleteOneTitle")
    );

  await click(deleteButton());
  assert.equal(
    dialog().getAttribute("data-dialog"),
    'dictionary.shared.deleteOneTitle{"word":"Qdrant","list":"Engineering"}'
  );
  await click(byAttribute(dialog(), "data-cancel"));
  assert.equal(dialog(), null);
  assert.equal(
    calls.find(([name]) => name === "deleteSharedWords"),
    undefined
  );

  await click(deleteButton());
  await click(byAttribute(dialog(), "data-confirm"));
  assert.equal(dialog(), null);
  assert.deepEqual(
    calls.filter(([name]) => name === "deleteSharedWords"),
    [["deleteSharedWords", "ws", ["e-qdrant"]]]
  );
  assert.equal(globalThis.__toasts.at(-1).actions[0].label, "dictionary.shared.undo");
});

test("personal and hidden rows have their own hover actions", async (t) => {
  const { container } = await renderView(t);
  await openList(container, "personal");
  assert.deepEqual(ariaLabels(rowFor(container, "OpenWhispr")), [
    named("dictionary.shared.selection.selectWord", "OpenWhispr"),
    named("dictionary.shared.actions.shareWord", "OpenWhispr"),
    named("dictionary.editWord", "OpenWhispr"),
    named("dictionary.shared.actions.deleteWord", "OpenWhispr"),
  ]);

  globalThis.__shared.snapshot = { ...SNAPSHOT, hiddenIds: ["e-arr"] };
  await openList(container, "hidden");
  assert.deepEqual(ariaLabels(rowFor(container, "ARR")), [
    named("dictionary.shared.actions.unhideWord", "ARR"),
  ]);
});

const targetChip = (container) =>
  findElement(
    container,
    (node) =>
      node.tagName === "BUTTON" &&
      node.getAttribute("aria-label") === "dictionary.shared.add.chooseList"
  );

test("add target defaults to the open list", async (t) => {
  const { container, storage } = await renderView(t, {
    initialStorage: { dictionaryAddTarget: JSON.stringify({ workspaceId: "ws", target: SALES }) },
  });
  await openList(container, `space:${ENGINEERING}`);
  assert.equal(targetChip(container).textContent, 'dictionary.shared.add.to{"list":"Engineering"}');

  await openList(container, "workspace");
  assert.equal(
    targetChip(container).textContent,
    'dictionary.shared.add.to{"list":"dictionary.shared.everyoneAt{\\"workspace\\":\\"Acme\\"}"}'
  );

  await openList(container, "personal");
  assert.equal(
    targetChip(container).textContent,
    'dictionary.shared.add.to{"list":"dictionary.shared.personal"}'
  );

  // Mixed views fall back to the list last used.
  await openList(container, "all");
  assert.equal(targetChip(container).textContent, 'dictionary.shared.add.to{"list":"Sales"}');

  // Picking a list remembers it.
  const engineering = findElement(
    container,
    (node) => node.getAttribute?.("data-menu-item") === "" && node.textContent === "Engineering"
  );
  await click(engineering);
  assert.equal(
    storage.getItem("dictionaryAddTarget"),
    JSON.stringify({ workspaceId: "ws", target: ENGINEERING })
  );
  assert.equal(targetChip(container).textContent, 'dictionary.shared.add.to{"list":"Engineering"}');
});

test("sort choice persists to localStorage", async (t) => {
  const { container, storage } = await renderView(t, {
    initialStorage: { dictionarySort: "za" },
  });
  await openList(container, "personal");
  const words = () =>
    container
      .querySelectorAll("li")
      .map((node) => node.getAttribute("data-word"))
      .filter(Boolean);
  assert.deepEqual(words(), ["Supabase", "OpenWhispr"]);

  const az = findElement(
    container,
    (node) =>
      node.getAttribute?.("data-menu-item") === "" &&
      node.textContent === "dictionary.shared.sort.az"
  );
  await click(az);
  assert.equal(storage.getItem("dictionarySort"), "az");
  assert.deepEqual(words(), ["OpenWhispr", "Supabase"]);
});

test("Enter adds to Personal through the settings store and to a shared list through the API", async (t) => {
  const { container, calls } = await renderView(t);
  globalThis.__results.addSharedWords = { added: ["Grafana"], alreadyPresent: [], failed: null };

  await openList(container, "personal");
  await type(addInput(container), "Grafana");
  await pressEnter(addInput(container));
  assert.deepEqual(
    calls.find(([name]) => name === "updateCustomDictionary"),
    ["updateCustomDictionary", { add: ["Grafana"] }]
  );
  assert.equal(addInput(container).value, "");

  await openList(container, `space:${ENGINEERING}`);
  await type(addInput(container), "Grafana");
  await pressEnter(addInput(container));
  assert.deepEqual(
    calls.find(([name]) => name === "addSharedWords"),
    ["addSharedWords", "ws", ENGINEERING, ["Grafana"]]
  );
});

test("a word already in the target is refused inline", async (t) => {
  const { container, calls } = await renderView(t);
  await openList(container, `space:${ENGINEERING}`);
  await type(addInput(container), "qdrant");
  assert.ok(container.textContent.includes('dictionary.shared.alreadyIn{"list":"Engineering"}'));
  await pressEnter(addInput(container));
  assert.equal(
    calls.find(([name]) => name === "addSharedWords"),
    undefined
  );
});

test("a rename the list already has keeps the editor open with the reason", async (t) => {
  const { container, calls } = await renderView(t);
  globalThis.__results.editSharedWord = "throw:alreadyInList";
  await openList(container, `space:${ENGINEERING}`);
  await click(buttonsIn(rowFor(container, "Qdrant"))[1]);
  const editor = () => findElement(rowFor(container, "Qdrant"), (node) => node.tagName === "INPUT");

  // An empty word is never sent.
  await type(editor(), "  ");
  await pressEnter(editor());
  assert.equal(
    calls.find(([name]) => name === "editSharedWord"),
    undefined
  );
  assert.ok(editor());

  await type(editor(), "sherpa-onnx ");
  await pressEnter(editor());
  assert.deepEqual(
    calls.find(([name]) => name === "editSharedWord"),
    ["editSharedWord", "ws", "e-qdrant", "sherpa-onnx"]
  );
  assert.ok(editor(), "the editor stays open");
  assert.ok(
    rowFor(container, "Qdrant").textContent.includes(
      'dictionary.shared.alreadyIn{"list":"Engineering"}'
    )
  );
});

test("Sync pulls the shared lists and the personal dictionary", async (t) => {
  const { container, calls } = await renderView(t);
  await click(byAttribute(container, "aria-label", "dictionary.shared.toolbar.sync"));
  assert.ok(calls.some(([name]) => name === "syncShared"));
  assert.ok(calls.some(([name]) => name === "syncPersonal"));
});

test("a failed Sync is logged, not left as an unhandled rejection, and stops spinning", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const { container, calls } = await renderView(t);
  globalThis.__results.syncShared = "reject";
  const syncButton = () => byAttribute(container, "aria-label", "dictionary.shared.toolbar.sync");
  await click(syncButton());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.ok(
    calls.some(([name]) => name === "log:warn"),
    "the failure is logged"
  );

  // The button ignores clicks while syncing, so a second run shows it was reset.
  await click(syncButton());
  assert.equal(calls.filter(([name]) => name === "syncShared").length, 2);
});

test("a Personal rename to a word only hidden under a shared copy goes through", async (t) => {
  const snapshot = {
    ...SNAPSHOT,
    entries: [...SNAPSHOT.entries, entry("e-supabase", "Supabase", null)],
  };
  const { container, calls } = await renderView(t, {
    shared: { snapshot, movedPersonal: ["Supabase"] },
  });
  await openList(container, "personal");
  const editButton = byAttribute(
    rowFor(container, "OpenWhispr"),
    "aria-label",
    named("dictionary.editWord", "OpenWhispr")
  );
  await click(editButton);
  const editor = () =>
    findElement(rowFor(container, "OpenWhispr"), (node) => node.tagName === "INPUT");
  await type(editor(), "supabase");
  await pressEnter(editor());
  assert.ok(!container.textContent.includes("dictionary.shared.alreadyIn"));
  assert.deepEqual(calls.filter(([name]) => name === "updateCustomDictionary").at(-1), [
    "updateCustomDictionary",
    { add: ["supabase"], remove: ["OpenWhispr"] },
  ]);
});

test("a Personal rename to a visible Personal word or the agent name is refused", async (t) => {
  const { container, calls } = await renderView(t);
  await openList(container, "personal");
  for (const word of ["supabase", "whispr"]) {
    await click(
      byAttribute(
        rowFor(container, "OpenWhispr"),
        "aria-label",
        named("dictionary.editWord", "OpenWhispr")
      )
    );
    const editor = findElement(rowFor(container, "OpenWhispr"), (node) => node.tagName === "INPUT");
    await type(editor, word);
    await pressEnter(editor);
    assert.ok(
      rowFor(container, "OpenWhispr").textContent.includes(
        'dictionary.shared.alreadyIn{"list":"dictionary.shared.personal"}'
      ),
      word
    );
    await keyDown(editor, "Escape");
  }
  assert.equal(
    calls.find(([name]) => name === "updateCustomDictionary"),
    undefined
  );
});

test("a requested list opens first and the request is cleared", async (t) => {
  const { container } = await renderView(t, {
    shared: { requestedList: `space:${SALES}` },
  });
  assert.equal(pickerEntry(container, `space:${SALES}`).getAttribute("aria-current"), "true");
  assert.equal(pickerEntry(container, "all").getAttribute("aria-current"), null);
  assert.equal(globalThis.__shared.requestedList, null);
  assert.ok(rowFor(container, "MEDDICC"));
});

test("clear-all and export leave out moved words, which can be added back", async (t) => {
  const snapshot = {
    ...SNAPSHOT,
    entries: [...SNAPSHOT.entries, entry("e-supabase", "Supabase", null)],
  };
  const { container, calls, exported } = await renderView(t, {
    shared: { snapshot, movedPersonal: ["Supabase"] },
  });
  await openList(container, "personal");
  assert.equal(rowFor(container, "Supabase"), null);

  await click(byAttribute(container, "aria-label", "dictionary.clearAll"));
  await click(
    byAttribute(byAttribute(container, "data-dialog", "dictionary.clearTitle"), "data-confirm")
  );
  assert.deepEqual(
    calls.find(([name]) => name === "updateCustomDictionary"),
    ["updateCustomDictionary", { remove: ["OpenWhispr"] }]
  );

  await click(byAttribute(container, "aria-label", "dictionary.exportDictionary"));
  // The export keeps the agent name, as it always has.
  assert.deepEqual(exported, [["OpenWhispr", "Whispr"]]);

  // A moved word isn't shown in Personal, so adding it back is allowed.
  await type(addInput(container), "Supabase");
  assert.ok(!container.textContent.includes("dictionary.shared.alreadyIn"));
  await pressEnter(addInput(container));
  assert.deepEqual(calls.filter(([name]) => name === "updateCustomDictionary").at(-1), [
    "updateCustomDictionary",
    { add: ["Supabase"] },
  ]);
});

const checkboxFor = (container, word) =>
  findElement(
    rowFor(container, word),
    (node) => node.tagName === "BUTTON" && node.getAttribute("role") === "checkbox"
  );

const shiftClick = (element) =>
  React.act(async () => element.dispatchEvent({ type: "click", bubbles: true, shiftKey: true }));

const keyDown = (element, key, extra = {}) =>
  React.act(async () => element.dispatchEvent(domEvent("keydown", { key, ...extra })));

// The floating selection bar, found by its accessible name.
const toolbar = (container) =>
  byAttribute(container, "aria-label", "dictionary.shared.selection.label");

const barButton = (container, label) =>
  findElement(
    toolbar(container),
    (node) => node.tagName === "BUTTON" && node.textContent === label
  );

const checkedWords = (container) =>
  container
    .querySelectorAll("li")
    .filter(
      (node) =>
        checkboxFor(container, node.getAttribute("data-word"))?.getAttribute("aria-checked") ===
        "true"
    )
    .map((node) => node.getAttribute("data-word"));

const FIVE_WORDS = { customDictionary: ["Biscuit", "Piha", "Qdrant", "sherpa-onnx", "Tiptap"] };

test("shift-click selects a range in the list", async (t) => {
  const { container } = await renderView(t, { settings: FIVE_WORDS });
  await openList(container, "personal");
  assert.equal(toolbar(container), null, "no bar until something is ticked");

  await click(checkboxFor(container, "Biscuit"));
  await shiftClick(checkboxFor(container, "Qdrant"));
  assert.deepEqual(checkedWords(container), ["Biscuit", "Piha", "Qdrant"]);

  const bar = toolbar(container).textContent;
  assert.ok(bar.includes('dictionary.shared.selection.count{"count":3}'));
  assert.ok(bar.includes('dictionary.shared.selection.selectAll{"total":5}'));
  // With a selection, rows keep only their checkbox: the hover actions step aside.
  assert.deepEqual(ariaLabels(rowFor(container, "Tiptap")), [
    named("dictionary.shared.selection.selectWord", "Tiptap"),
  ]);

  await click(barButton(container, 'dictionary.shared.selection.selectAll{"total":5}'));
  assert.equal(checkedWords(container).length, 5);
});

test("⌘A selects all while the list has focus, Esc clears, and a new list starts empty", async (t) => {
  const { container, calls } = await renderView(t, { settings: FIVE_WORDS });
  await openList(container, "personal");
  const list = container.querySelector("ul");

  // The add field keeps ⌘A for its text.
  await keyDown(addInput(container), "a", { metaKey: true, code: "KeyA" });
  assert.equal(toolbar(container), null);

  // By physical key: a Russian layout's ⌘A sends "ф".
  await keyDown(list, "ф", { metaKey: true, code: "KeyA" });
  assert.equal(checkedWords(container).length, 5);
  await keyDown(list, "Escape");
  assert.equal(toolbar(container), null);

  await click(checkboxFor(container, "Piha"));
  await click(barButton(container, "dictionary.shared.actions.delete"));
  assert.deepEqual(calls.filter(([name]) => name === "updateCustomDictionary").at(-1), [
    "updateCustomDictionary",
    { remove: ["Piha"] },
  ]);
  assert.equal(toolbar(container), null, "a finished bulk action clears the selection");
  assert.deepEqual(globalThis.__toasts, [], "deleting one word offers no Undo, as before");

  await click(checkboxFor(container, "Tiptap"));
  await openList(container, "all");
  assert.equal(toolbar(container), null);
});

test("the selection bar shares to the ticked lists; unshared words stay selected", async (t) => {
  const { container, calls } = await renderView(t, { settings: FIVE_WORDS });
  await openList(container, "personal");
  await click(checkboxFor(container, "Biscuit"));
  await click(checkboxFor(container, "Piha"));

  await click(barButton(container, "dictionary.shared.selection.shareWith"));
  const popover = () => byAttribute(container, "data-popover");
  assert.ok(popover().textContent.includes('dictionary.shared.share.titleMany{"count":2}'));
  const engineering = findElement(
    popover(),
    (node) =>
      node.getAttribute?.("role") === "checkbox" && node.textContent.startsWith("Engineering")
  );
  await click(engineering);
  globalThis.__results.sharePersonalWords = {
    moved: ["Biscuit"],
    alreadyPresent: [],
    failed: { words: ["Piha"], reason: "personalChanged" },
  };
  const share = () =>
    findElement(
      popover(),
      (node) =>
        node.tagName === "BUTTON" &&
        node.getAttribute("role") !== "checkbox" &&
        node.textContent === "dictionary.shared.actions.share"
    );
  await click(share());

  assert.deepEqual(
    calls.find(([name]) => name === "sharePersonalWords"),
    ["sharePersonalWords", "ws", [ENGINEERING], ["Biscuit", "Piha"]]
  );
  assert.deepEqual(globalThis.__toasts.at(-1), {
    title: 'dictionary.shared.share.partial{"moved":1,"total":2,"count":1}',
    description: "dictionary.shared.share.reasons.personalChanged",
    variant: "destructive",
  });
  assert.equal(popover(), null);
  // The mock leaves Biscuit in Personal; the real move takes it out of the list.
  assert.deepEqual(checkedWords(container), ["Biscuit", "Piha"]);

  // A full share clears the selection.
  globalThis.__results.sharePersonalWords = { moved: ["Piha"], alreadyPresent: [], failed: null };
  await click(barButton(container, "dictionary.shared.selection.shareWith"));
  await click(
    findElement(
      popover(),
      (node) =>
        node.getAttribute?.("role") === "checkbox" && node.textContent.startsWith("Engineering")
    )
  );
  await click(share());
  assert.equal(toolbar(container), null);
});

test("a row's Share icon opens the popover for that word", async (t) => {
  const { container } = await renderView(t);
  await openList(container, "personal");
  await click(
    byAttribute(container, "aria-label", named("dictionary.shared.actions.shareWord", "OpenWhispr"))
  );
  assert.ok(
    byAttribute(container, "data-popover").textContent.includes(
      'dictionary.shared.share.titleOne{"word":"OpenWhispr"}'
    )
  );
});

test("a shared list's bar hides for me and deletes for everyone after confirming", async (t) => {
  const { container, calls } = await renderView(t);
  await openList(container, `space:${ENGINEERING}`);
  // Personal-only actions never show for shared words.
  await click(checkboxFor(container, "Qdrant"));
  assert.equal(barButton(container, "dictionary.shared.selection.shareWith"), null);
  await click(checkboxFor(container, "sherpa-onnx"));

  await click(barButton(container, "dictionary.shared.actions.hide"));
  assert.deepEqual(
    calls.find(([name]) => name === "setSharedWordsHidden"),
    ["setSharedWordsHidden", "ws", ["e-qdrant", "e-sherpa"], true]
  );
  assert.equal(toolbar(container), null);

  await click(checkboxFor(container, "Qdrant"));
  await click(checkboxFor(container, "sherpa-onnx"));
  await click(barButton(container, "dictionary.shared.actions.deleteForEveryone"));
  const dialog = byAttribute(
    container,
    "data-dialog",
    'dictionary.shared.deleteManyTitle{"count":2,"list":"Engineering"}'
  );
  assert.ok(dialog);
  assert.equal(
    calls.find(([name]) => name === "deleteSharedWords"),
    undefined
  );
  await click(byAttribute(dialog, "data-confirm"));
  assert.deepEqual(
    calls.find(([name]) => name === "deleteSharedWords"),
    ["deleteSharedWords", "ws", ["e-qdrant", "e-sherpa"]]
  );
  assert.equal(globalThis.__toasts.at(-1).actions[0].label, "dictionary.shared.undo");
  assert.equal(toolbar(container), null);
});

test("the Hidden list has no checkboxes", async (t) => {
  const { container } = await renderView(t, {
    shared: { snapshot: { ...SNAPSHOT, hiddenIds: ["e-arr"] } },
  });
  await openList(container, "hidden");
  assert.equal(checkboxFor(container, "ARR"), null);
});

test("⌘A then Delete in Personal offers Undo, which adds every removed word back", async (t) => {
  const { container, calls } = await renderView(t, { settings: FIVE_WORDS });
  await openList(container, "personal");
  await keyDown(container.querySelector("ul"), "a", { metaKey: true, code: "KeyA" });
  await click(barButton(container, "dictionary.shared.actions.delete"));

  const removed = ["Biscuit", "Piha", "Qdrant", "sherpa-onnx", "Tiptap"];
  assert.deepEqual(calls.filter(([name]) => name === "updateCustomDictionary").at(-1), [
    "updateCustomDictionary",
    { remove: removed },
  ]);
  const toast = globalThis.__toasts.at(-1);
  assert.equal(toast.title, 'dictionary.shared.deletedPersonalMany{"count":5}');
  assert.equal(toast.actions[0].label, "dictionary.shared.undo");

  await React.act(async () => toast.actions[0].onClick());
  assert.deepEqual(calls.filter(([name]) => name === "updateCustomDictionary").at(-1), [
    "updateCustomDictionary",
    { add: removed },
  ]);
});

const shareTo = async (container, labels) => {
  await click(barButton(container, "dictionary.shared.selection.shareWith"));
  const popover = byAttribute(container, "data-popover");
  for (const label of labels) {
    await click(
      findElement(
        popover,
        (node) => node.getAttribute?.("role") === "checkbox" && node.textContent.startsWith(label)
      )
    );
  }
  await click(
    findElement(
      popover,
      (node) =>
        node.tagName === "BUTTON" &&
        node.getAttribute("role") !== "checkbox" &&
        node.textContent === "dictionary.shared.actions.share"
    )
  );
};

test("a full list is named when known and generic when the share went to several", async (t) => {
  const { container } = await renderView(t, { settings: FIVE_WORDS });
  await openList(container, "personal");
  await click(checkboxFor(container, "Biscuit"));
  await click(checkboxFor(container, "Piha"));
  await click(checkboxFor(container, "Tiptap"));

  globalThis.__results.sharePersonalWords = {
    moved: ["Biscuit"],
    alreadyPresent: [],
    failed: { words: ["Piha", "Tiptap"], reason: "listFull", target: ENGINEERING },
  };
  await shareTo(container, ["Engineering"]);
  assert.deepEqual(globalThis.__toasts.at(-1), {
    title: 'dictionary.shared.share.partial{"moved":1,"total":3,"count":2}',
    description: 'dictionary.shared.errors.listFull{"list":"Engineering"}',
    variant: "destructive",
  });

  globalThis.__results.sharePersonalWords = {
    moved: [],
    alreadyPresent: [],
    failed: { words: ["Biscuit", "Piha", "Tiptap"], reason: "listFull" },
  };
  await shareTo(container, ["Engineering", "Sales"]);
  assert.deepEqual(globalThis.__toasts.at(-1), {
    title: "dictionary.shared.share.reasons.aListFull",
    variant: "destructive",
  });
});

test("a ticked row that leaves the list isn't still ticked when it comes back", async (t) => {
  const { container, rerender } = await renderView(t, { settings: FIVE_WORDS });
  await openList(container, "personal");
  await click(checkboxFor(container, "Piha"));
  await click(checkboxFor(container, "Tiptap"));

  await click(byAttribute(container, "aria-label", "dictionary.shared.toolbar.search"));
  const search = () =>
    findElement(
      container,
      (node) =>
        node.tagName === "INPUT" &&
        node.getAttribute("aria-label") === "dictionary.shared.toolbar.search"
    );
  await type(search(), "ti");
  assert.deepEqual(checkedWords(container), ["Tiptap"]);
  // The search only hides Piha, so it stays selected and counted.
  assert.ok(
    toolbar(container).textContent.includes('dictionary.shared.selection.count{"count":2}')
  );

  await type(search(), "");
  assert.deepEqual(checkedWords(container), ["Piha", "Tiptap"], "a search never unticks");

  // A word that is removed from the dictionary is unticked for good.
  globalThis.__settings = { ...globalThis.__settings, customDictionary: ["Biscuit", "Tiptap"] };
  await rerender();
  globalThis.__settings = {
    ...globalThis.__settings,
    customDictionary: FIVE_WORDS.customDictionary,
  };
  await rerender();
  assert.deepEqual(checkedWords(container), ["Tiptap"], "Piha left the list, so it was unticked");
});

const isDisabled = (node) => node.disabled === true || node.getAttribute("disabled") !== null;
const buttonWithText = (container, text) =>
  findElement(container, (node) => node.tagName === "BUTTON" && node.textContent === text);
const PAUSED = { ...SNAPSHOT, meta: { ...SNAPSHOT.meta, paused: true } };

test("a locked shared list shows the upsell over dimmed lists, and View Plans opens billing", async (t) => {
  const { container, calls } = await renderView(t);
  globalThis.__workspace = { ...globalThis.__workspace, plan: "pro", role: "owner" };
  await openList(container, "allShared");
  assert.ok(
    container.textContent.includes('dictionary.shared.locked.upgradeAdmin{"workspace":"Acme"}')
  );
  assert.equal(addInput(container), null, "a locked list has no add field");
  assert.equal(rowFor(container, "ARR"), null, "no words while locked");
  assert.ok(container.textContent.includes('dictionary.shared.memberCount{"count":14}'));

  await click(buttonWithText(container, "integrations.api.viewPlans"));
  assert.ok(calls.some(([name]) => name === "upgrade"));
});

test("a paused list shows its words dimmed and read-only", async (t) => {
  const { container } = await renderView(t, { shared: { snapshot: PAUSED } });
  await openList(container, "workspace");
  assert.ok(container.textContent.includes("dictionary.shared.locked.paused"));
  const row = rowFor(container, "ARR");
  assert.ok(row, "the list's words are shown");
  assert.deepEqual(buttonsIn(row), [], "no hover actions or checkboxes");
  assert.ok(isDisabled(addInput(container)), "the add field is disabled");
  assert.equal(
    targetChip(container).textContent,
    'dictionary.shared.add.to{"list":"dictionary.shared.everyoneAt{\\"workspace\\":\\"Acme\\"}"}',
    "the disabled field names the open list"
  );

  // All shared stays the per-list summary.
  await openList(container, "allShared");
  assert.equal(rowFor(container, "ARR"), null);
  assert.ok(container.textContent.includes('dictionary.shared.locked.wordCount{"count":2}'));
});

test("a free workspace's empty lists ask a member to upgrade, even though the API says paused", async (t) => {
  const snapshot = {
    entries: [],
    hiddenIds: [],
    meta: {
      ...SNAPSHOT.meta,
      paused: true,
      scopes: SNAPSHOT.meta.scopes.map((scope) => ({ ...scope, word_count: 0 })),
    },
  };
  const { container } = await renderView(t, { shared: { snapshot } });
  globalThis.__workspace = { ...globalThis.__workspace, plan: "pro", role: "member" };
  await openList(container, "workspace");
  assert.ok(container.textContent.includes("dictionary.shared.locked.upgradeMember"));
  assert.ok(!container.textContent.includes("dictionary.shared.locked.paused"));
  assert.equal(buttonWithText(container, "integrations.api.viewPlans"), null);
});

test("an empty list imports into itself or sends the member to Personal", async (t) => {
  const SUPPORT = "33333333-3333-4333-8333-333333333333";
  const snapshot = {
    ...SNAPSHOT,
    meta: {
      ...SNAPSHOT.meta,
      scopes: [
        ...SNAPSHOT.meta.scopes,
        { space_id: SUPPORT, name: "Support", member_count: 4, word_count: 0 },
      ],
    },
  };
  const { container } = await renderView(t, { shared: { snapshot } });
  await openList(container, `space:${SUPPORT}`);
  assert.ok(container.textContent.includes('dictionary.shared.emptyList{"list":"Support"}'));
  assert.ok(
    container.textContent.includes('dictionary.shared.empty.body{"list":"Support","count":4}')
  );

  await click(buttonWithText(container, "dictionary.shared.empty.import"));
  assert.ok(
    buttonWithText(container, 'dictionary.shared.importTo{"list":"Support"}'),
    "the bulk import is aimed at this list"
  );

  await click(buttonWithText(container, "dictionary.shared.empty.shareFromPersonal"));
  assert.equal(pickerEntry(container, "personal").getAttribute("aria-current"), "true");
  assert.ok(rowFor(container, "OpenWhispr"), "Personal is open");
  // ...in select mode: the bar is up with nothing ticked yet, and the rows show their checkboxes.
  assert.ok(
    toolbar(container).textContent.includes('dictionary.shared.selection.count{"count":0}')
  );
  assert.deepEqual(ariaLabels(rowFor(container, "Supabase")), [
    named("dictionary.shared.selection.selectWord", "Supabase"),
  ]);
  await click(byAttribute(container, "aria-label", "dictionary.shared.selection.clear"));
  assert.equal(toolbar(container), null);
});

test("a list whose words are all hidden says so, without the empty list's buttons", async (t) => {
  const snapshot = { ...SNAPSHOT, hiddenIds: ["e-qdrant", "e-sherpa"] };
  const { container } = await renderView(t, { shared: { snapshot } });
  await openList(container, `space:${ENGINEERING}`);
  assert.ok(
    container.textContent.includes('dictionary.shared.allHiddenList{"list":"Engineering"}')
  );
  assert.ok(!container.textContent.includes("dictionary.shared.emptyList"));
  assert.equal(buttonWithText(container, "dictionary.shared.empty.import"), null);
  assert.equal(buttonWithText(container, "dictionary.shared.empty.shareFromPersonal"), null);
});

const focusOut = (element) =>
  React.act(async () => element.dispatchEvent(domEvent("focusout", { relatedTarget: null })));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("All words offers Clear all and Export while it lists only personal words", async (t) => {
  const { container, rerender } = await renderView(t);
  // Shared words apply here, so All words isn't Personal and keeps them out.
  assert.equal(byAttribute(container, "aria-label", "dictionary.clearAll"), null);

  globalThis.__workspace = { ...globalThis.__workspace, plan: "pro" };
  await rerender();
  assert.ok(byAttribute(container, "aria-label", "dictionary.clearAll"));
  assert.ok(byAttribute(container, "aria-label", "dictionary.exportDictionary"));
});

for (const status of ["ssoRequired", "noAccess"]) {
  test(`${status}: the shared lists are locked and the add field is Personal-only`, async (t) => {
    const { container } = await renderView(t, { shared: { status } });
    await openList(container, "workspace");
    assert.ok(
      container.textContent.includes(`dictionary.shared.locked.${status}{"workspace":"Acme"}`)
    );
    assert.equal(addInput(container), null);
    assert.equal(buttonWithText(container, "integrations.api.viewPlans"), null);
    assert.ok(
      pickerEntry(container, "workspace").textContent.includes("dictionary.shared.lockedEntry")
    );

    await openList(container, "all");
    assert.equal(rowFor(container, "ARR"), null, "shared words don't apply");
    assert.equal(
      targetChip(container).textContent,
      'dictionary.shared.add.to{"list":"dictionary.shared.personal"}'
    );
  });
}

test("a failure that retrying can't fix names its cause instead of asking to try again", async (t) => {
  const { container } = await renderView(t);
  await openList(container, "workspace");
  globalThis.__results.addSharedWords = {
    added: [],
    alreadyPresent: [],
    rejected: [],
    failed: { words: ["Foo"], reason: "planRequired" },
  };
  await type(addInput(container), "Foo");
  await pressEnter(addInput(container));
  const list = 'dictionary.shared.everyoneAt{\\"workspace\\":\\"Acme\\"}';
  assert.equal(
    globalThis.__toasts.at(-1).title,
    `dictionary.shared.errors.planRequired{"list":"${list}"}`
  );

  globalThis.__results.setSharedWordsHidden = "throw:ssoRequired";
  await click(
    byAttribute(container, "aria-label", named("dictionary.shared.actions.hideWord", "ARR"))
  );
  assert.match(globalThis.__toasts.at(-1).title, /^dictionary\.shared\.errors\.ssoRequired/);

  globalThis.__results.setSharedWordsHidden = "throw:network";
  await click(
    byAttribute(container, "aria-label", named("dictionary.shared.actions.hideWord", "ARR"))
  );
  assert.match(globalThis.__toasts.at(-1).title, /^dictionary\.shared\.errors\.generic/);
});

test("All words shows a word in two lists once, and hiding it hides both copies", async (t) => {
  const snapshot = {
    ...SNAPSHOT,
    entries: [...SNAPSHOT.entries, entry("e-qdrant-ws", "qdrant", null)],
  };
  const { container, calls } = await renderView(t, { shared: { snapshot } });
  assert.match(
    rowFor(container, "Qdrant").textContent,
    /dictionary\.shared\.badgeMore\{"list":"Engineering","extra":1\}/
  );
  await click(
    byAttribute(container, "aria-label", named("dictionary.shared.actions.hideWord", "Qdrant"))
  );
  assert.deepEqual(
    calls.find(([name]) => name === "setSharedWordsHidden"),
    ["setSharedWordsHidden", "ws", ["e-qdrant", "e-qdrant-ws"], true]
  );

  await click(
    byAttribute(
      container,
      "aria-label",
      named("dictionary.shared.actions.deleteForEveryoneWord", "Qdrant")
    )
  );
  const dialog = findElement(container, (node) =>
    node.getAttribute?.("data-dialog")?.includes("deleteOneTitle")
  );
  assert.ok(dialog.getAttribute("data-dialog").includes("Engineering"));
  await click(byAttribute(dialog, "data-confirm"));
  assert.deepEqual(
    calls.find(([name]) => name === "deleteSharedWords"),
    ["deleteSharedWords", "ws", ["e-qdrant", "e-qdrant-ws"]]
  );
});

test("Delete in a mixed selection removes the personal words and keeps the shared ones selected", async (t) => {
  const { container, calls } = await renderView(t);
  await click(checkboxFor(container, "OpenWhispr"));
  await click(checkboxFor(container, "ARR"));
  await click(barButton(container, "dictionary.shared.actions.delete"));
  assert.deepEqual(calls.filter(([name]) => name === "updateCustomDictionary").at(-1), [
    "updateCustomDictionary",
    { remove: ["OpenWhispr"] },
  ]);
  assert.ok(toolbar(container), "the shared word is still selected");
  assert.ok(checkedWords(container).includes("ARR"));
});

test("a word a shared list can't use is refused before it's sent, and badged where it exists", async (t) => {
  const snapshot = { ...SNAPSHOT, entries: [...SNAPSHOT.entries, entry("e-pipe", "a | b", null)] };
  const { container, calls } = await renderView(t, {
    shared: { snapshot },
    settings: { customDictionary: ["OpenWhispr", "x<y>"] },
  });
  await openList(container, "workspace");
  assert.ok(rowFor(container, "a | b").textContent.includes("dictionary.shared.notUsed"));
  assert.ok(!rowFor(container, "ARR").textContent.includes("dictionary.shared.notUsed"));

  await type(addInput(container), "<script>");
  assert.ok(container.textContent.includes("dictionary.shared.notTermLike"));
  await pressEnter(addInput(container));
  assert.equal(
    calls.find(([name]) => name === "addSharedWords"),
    undefined
  );

  // Personal words never reach a teammate, so Personal takes them.
  await openList(container, "personal");
  await type(addInput(container), "<script>");
  assert.ok(!container.textContent.includes("dictionary.shared.notTermLike"));

  // Sharing one from Personal is refused in the popover.
  await click(
    byAttribute(container, "aria-label", named("dictionary.shared.actions.shareWord", "x<y>"))
  );
  const popover = byAttribute(container, "data-popover");
  assert.ok(popover.textContent.includes("dictionary.shared.notTermLike"));
  assert.ok(isDisabled(buttonWithText(popover, "dictionary.shared.actions.share")));
});

test("a refused rename closes when focus leaves; a failed save keeps its text", async (t) => {
  const { container, calls } = await renderView(t);
  await openList(container, `space:${ENGINEERING}`);
  const editor = () => findElement(rowFor(container, "Qdrant"), (node) => node.tagName === "INPUT");
  const openEditor = () =>
    click(byAttribute(container, "aria-label", named("dictionary.editWord", "Qdrant")));

  globalThis.__results.editSharedWord = "throw:alreadyInList";
  await openEditor();
  await type(editor(), "sherpa-onnx");
  await pressEnter(editor());
  assert.ok(editor(), "Enter keeps the refused editor open with its reason");
  assert.equal(editor().getAttribute("aria-describedby") !== null, true);
  await focusOut(editor());
  assert.equal(editor(), null, "leaving a refused edit reverts it");
  assert.equal(calls.filter(([name]) => name === "editSharedWord").length, 1);

  globalThis.__results.editSharedWord = "throw:network";
  await openEditor();
  await type(editor(), "Qdrant DB");
  // The user clicked somewhere else; the failed save mustn't pull the focus back.
  globalThis.document.activeElement = null;
  await focusOut(editor());
  assert.ok(editor(), "a failed save stays open");
  assert.equal(globalThis.document.activeElement, null, "the focus stays where the user put it");
  assert.equal(editor().value, "Qdrant DB");
  assert.ok(
    rowFor(container, "Qdrant").textContent.includes(
      'dictionary.shared.errors.generic{"list":"Engineering"}'
    )
  );
  // Leaving again doesn't resend the same failed text.
  await focusOut(editor());
  assert.equal(calls.filter(([name]) => name === "editSharedWord").length, 2);
});

test("View words opens the Dictionary tab and the asked-for list", async (t) => {
  const { container, rerender } = await renderView(t);
  await click(byAttribute(container, "data-tab", "snippets"));
  assert.equal(addInput(container), null, "the Snippets tab is open");

  globalThis.__shared.requestedList = "allShared";
  await rerender();
  assert.ok(addInput(container), "the Dictionary tab is open again");
  assert.equal(pickerEntry(container, "allShared").getAttribute("aria-current"), "true");
});

test("a change from the other window rereads the shared lists once", async (t) => {
  const { calls, emitSyncEvent } = await renderView(t);
  const reloads = () => calls.filter(([name]) => name === "reload").length;
  const before = reloads();
  await React.act(async () => {
    emitSyncEvent({ name: "shared-dictionary-changed", payload: { workspaceId: "ws" } });
    emitSyncEvent({ name: "shared-dictionary-changed", payload: { workspaceId: "ws" } });
    emitSyncEvent({ name: "shared-dictionary-changed", payload: { workspaceId: "other" } });
    emitSyncEvent({ name: "notes-changed", payload: {} });
    await wait(300);
  });
  assert.equal(reloads(), before + 1);
});

test("a comma list or import adds the words a shared list takes and names the rest", async (t) => {
  const { container, calls } = await renderView(t);
  await openList(container, "workspace");
  globalThis.__results.addSharedWords = {};
  await type(addInput(container), "Helm, a<b, c|d, {e}, f`g, Argo");
  assert.ok(
    !container.textContent.includes("dictionary.shared.notTermLike"),
    "a list isn't blocked"
  );
  await pressEnter(addInput(container));
  assert.deepEqual(
    calls.find(([name]) => name === "addSharedWords"),
    ["addSharedWords", "ws", null, ["Helm", "Argo"]]
  );
  assert.deepEqual(globalThis.__toasts.at(-1), {
    title: 'dictionary.shared.skipped{"count":4,"words":"a<b, c|d, {e}, …"}',
    description: "dictionary.shared.notTermLike",
    variant: "default",
  });
  assert.equal(addInput(container).value, "", "what went in clears the field");
});

test("sharing a selection moves the words a shared list takes and keeps the rest selected", async (t) => {
  const { container, calls } = await renderView(t, {
    settings: { customDictionary: ["OpenWhispr", "x<y>"] },
  });
  await openList(container, "personal");
  await click(checkboxFor(container, "OpenWhispr"));
  await click(checkboxFor(container, "x<y>"));
  globalThis.__results.sharePersonalWords = { moved: ["OpenWhispr"], alreadyPresent: [] };
  await shareTo(container, ["Engineering"]);
  assert.deepEqual(
    calls.find(([name]) => name === "sharePersonalWords"),
    ["sharePersonalWords", "ws", [ENGINEERING], ["OpenWhispr"]]
  );
  assert.equal(
    globalThis.__toasts.at(-1).title,
    'dictionary.shared.skipped{"count":1,"words":"x<y>"}'
  );
  assert.ok(checkedWords(container).includes("x<y>"), "the word left out stays selected");
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("renaming a word All words shows once renames its copy in every list", async (t) => {
  const snapshot = {
    ...SNAPSHOT,
    entries: [...SNAPSHOT.entries, entry("e-qdrant-ws", "qdrant", null)],
  };
  const { container, calls } = await renderView(t, { shared: { snapshot } });
  const editor = () => findElement(rowFor(container, "Qdrant"), (node) => node.tagName === "INPUT");
  await click(byAttribute(container, "aria-label", named("dictionary.editWord", "Qdrant")));
  await type(editor(), "Qdrant DB");
  await pressEnter(editor());
  assert.deepEqual(
    calls.filter(([name]) => name === "editSharedWord"),
    [
      ["editSharedWord", "ws", "e-qdrant", "Qdrant DB"],
      ["editSharedWord", "ws", "e-qdrant-ws", "Qdrant DB"],
    ]
  );
  assert.equal(editor(), null, "the editor closes once every copy is renamed");

  // One copy failing still renames the other, and the editor names the list that failed.
  calls.length = 0;
  globalThis.__results.editSharedWord = (_workspaceId, entryId) =>
    entryId === "e-qdrant-ws" ? "throw:recentlyDeleted" : undefined;
  await click(byAttribute(container, "aria-label", named("dictionary.editWord", "Qdrant")));
  await type(editor(), "Qdrant DB");
  await pressEnter(editor());
  assert.equal(calls.filter(([name]) => name === "editSharedWord").length, 2);
  assert.ok(editor(), "a failed copy keeps the editor open");
  assert.ok(
    rowFor(container, "Qdrant").textContent.includes(
      'dictionary.shared.errors.recentlyDeleted{"list":"dictionary.shared.everyoneAt{\\"workspace\\":\\"Acme\\"}"}'
    )
  );
});

test("the confirm dialogs' buttons are translated", async (t) => {
  const { container } = await renderView(t);
  await openList(container, `space:${ENGINEERING}`);
  await click(
    byAttribute(
      container,
      "aria-label",
      named("dictionary.shared.actions.deleteForEveryoneWord", "Qdrant")
    )
  );
  const deleteDialog = findElement(container, (node) =>
    node.getAttribute?.("data-dialog")?.includes("deleteOneTitle")
  );
  assert.equal(
    deleteDialog.getAttribute("data-confirm-text"),
    "dictionary.shared.actions.deleteForEveryone"
  );
  assert.equal(deleteDialog.getAttribute("data-cancel-text"), "common.cancel");
  await click(byAttribute(deleteDialog, "data-cancel"));

  await openList(container, "personal");
  await click(byAttribute(container, "aria-label", "dictionary.clearAll"));
  const clearDialog = byAttribute(container, "data-dialog", "dictionary.clearTitle");
  assert.equal(clearDialog.getAttribute("data-confirm-text"), "dictionary.clearAll");
  assert.equal(clearDialog.getAttribute("data-cancel-text"), "common.cancel");
});

test("a Delete for everyone left open is withdrawn when the workspace changes", async (t) => {
  const { container, calls, rerender } = await renderView(t);
  await openList(container, `space:${ENGINEERING}`);
  await click(
    byAttribute(
      container,
      "aria-label",
      named("dictionary.shared.actions.deleteForEveryoneWord", "Qdrant")
    )
  );
  const dialog = () =>
    findElement(container, (node) =>
      node.getAttribute?.("data-dialog")?.includes("deleteOneTitle")
    );
  assert.ok(dialog());

  globalThis.__workspace = { ...globalThis.__workspace, id: "ws-b", name: "Beta" };
  await rerender();
  assert.equal(dialog(), null);
  // Coming back doesn't bring it back either.
  globalThis.__workspace = { ...globalThis.__workspace, id: "ws", name: "Acme" };
  await rerender();
  assert.equal(dialog(), null);
  assert.equal(
    calls.find(([name]) => name === "deleteSharedWords"),
    undefined
  );
});

test("the remembered add target only applies in the workspace it was picked in", async (t) => {
  const { container, rerender } = await renderView(t, {
    initialStorage: { dictionaryAddTarget: JSON.stringify({ workspaceId: "ws", target: null }) },
  });
  assert.equal(
    targetChip(container).textContent,
    'dictionary.shared.add.to{"list":"dictionary.shared.everyoneAt{\\"workspace\\":\\"Acme\\"}"}'
  );

  globalThis.__workspace = { ...globalThis.__workspace, id: "ws-b", name: "Beta" };
  await rerender();
  assert.equal(
    targetChip(container).textContent,
    'dictionary.shared.add.to{"list":"dictionary.shared.personal"}',
    "another workspace's list starts on Personal, not on everyone there"
  );
});

test("a word only hidden for the member offers Unhide instead of Already in", async (t) => {
  const { container, calls } = await renderView(t, {
    shared: { snapshot: { ...SNAPSHOT, hiddenIds: ["e-qdrant"] } },
  });
  await openList(container, `space:${ENGINEERING}`);
  await type(addInput(container), "qdrant");
  assert.ok(
    container.textContent.includes('dictionary.shared.add.hiddenForYou{"list":"Engineering"}')
  );
  assert.ok(!container.textContent.includes("dictionary.shared.alreadyIn"));
  await pressEnter(addInput(container));
  assert.equal(
    calls.find(([name]) => name === "addSharedWords"),
    undefined
  );

  await click(
    byAttribute(container, "aria-label", named("dictionary.shared.actions.unhideWord", "qdrant"))
  );
  assert.deepEqual(
    calls.find(([name]) => name === "setSharedWordsHidden"),
    ["setSharedWordsHidden", "ws", ["e-qdrant"], false]
  );
  assert.equal(addInput(container).value, "", "the word is back, so the field clears");

  // A word the member can see is still just Already in.
  await type(addInput(container), "sherpa-onnx");
  assert.ok(container.textContent.includes('dictionary.shared.alreadyIn{"list":"Engineering"}'));
  assert.ok(!container.textContent.includes("dictionary.shared.add.hiddenForYou"));
});

test("View words clears a search that would hide the asked-for words", async (t) => {
  const { container, rerender } = await renderView(t);
  await click(byAttribute(container, "aria-label", "dictionary.shared.toolbar.search"));
  const search = findElement(
    container,
    (node) =>
      node.tagName === "INPUT" &&
      node.getAttribute("aria-label") === "dictionary.shared.toolbar.search"
  );
  await type(search, "zzz");
  assert.equal(rowFor(container, "MEDDICC"), null);

  globalThis.__shared.requestedList = `space:${SALES}`;
  await rerender();
  assert.ok(rowFor(container, "MEDDICC"));
});

test("a bulk import or Hide for me in flight ignores a second click", async (t) => {
  const { container, calls } = await renderView(t);
  await openList(container, "workspace");
  const importing = deferred();
  globalThis.__results.addSharedWords = () => importing.promise;
  await click(byAttribute(container, "aria-label", "dictionary.importWords"));
  await type(
    findElement(container, (node) => node.tagName === "TEXTAREA"),
    "Helm, Argo"
  );
  const importButton = () =>
    buttonWithText(
      container,
      'dictionary.shared.importTo{"list":"dictionary.shared.everyoneAt{\\"workspace\\":\\"Acme\\"}"}'
    );
  await click(importButton());
  await click(importButton());
  assert.equal(calls.filter(([name]) => name === "addSharedWords").length, 1);
  assert.ok(isDisabled(importButton()));
  await React.act(async () => importing.resolve({}));
  assert.equal(
    findElement(container, (node) => node.tagName === "TEXTAREA"),
    null
  );

  await openList(container, `space:${ENGINEERING}`);
  const hiding = deferred();
  globalThis.__results.setSharedWordsHidden = () => hiding.promise;
  await click(checkboxFor(container, "Qdrant"));
  await click(barButton(container, "dictionary.shared.actions.hide"));
  await click(barButton(container, "dictionary.shared.actions.hide"));
  assert.equal(calls.filter(([name]) => name === "setSharedWordsHidden").length, 1);
  await React.act(async () => hiding.resolve());
  assert.equal(toolbar(container), null);
});

const partialError = (reason, appliedCount, undo) => {
  const error = new globalThis.__ActionError(reason);
  error.appliedCount = appliedCount;
  error.undo = undo;
  return error;
};

test("paused: Clear all, Export and Already in act on the moved words Personal shows again", async (t) => {
  const snapshot = {
    ...PAUSED,
    entries: [...PAUSED.entries, entry("e-supabase", "Supabase", null)],
  };
  const { container, calls, exported } = await renderView(t, {
    shared: { snapshot, movedPersonal: ["Supabase"] },
  });
  await openList(container, "personal");
  assert.ok(rowFor(container, "Supabase"), "the moved word applies at personal priority");

  await type(addInput(container), "supabase");
  assert.ok(
    container.textContent.includes(
      'dictionary.shared.alreadyIn{"list":"dictionary.shared.personal"}'
    )
  );

  await click(byAttribute(container, "aria-label", "dictionary.clearAll"));
  await click(
    byAttribute(byAttribute(container, "data-dialog", "dictionary.clearTitle"), "data-confirm")
  );
  assert.deepEqual(
    calls.find(([name]) => name === "updateCustomDictionary"),
    ["updateCustomDictionary", { remove: ["OpenWhispr", "Supabase"] }]
  );

  await click(byAttribute(container, "aria-label", "dictionary.exportDictionary"));
  assert.deepEqual(exported, [["OpenWhispr", "Supabase", "Whispr"]]);
});

test("signed out, the page is Personal alone with no Business upsell", async (t) => {
  globalThis.__signedIn = false;
  const { container, rerender } = await renderView(t);
  globalThis.__workspace = null;
  await rerender();
  assert.equal(pickerEntry(container, "all"), null);
  assert.ok(!container.textContent.includes("dictionary.shared.group"));
  assert.ok(!container.textContent.includes("dictionary.shared.locked"));
  assert.ok(rowFor(container, "OpenWhispr"));
  assert.ok(byAttribute(container, "aria-label", "dictionary.clearAll"));
});

test("signed in without a workspace, the Shared lists keep the Business upsell", async (t) => {
  const { container, rerender } = await renderView(t, { shared: { snapshot: null } });
  globalThis.__workspace = null;
  await rerender();
  assert.ok(container.textContent.includes("dictionary.shared.group"));
  await openList(container, "allShared");
  assert.ok(container.textContent.includes("dictionary.shared.locked.noWorkspace"));
});

test("a Delete for everyone that stops part-way counts what went and keeps Undo for it", async (t) => {
  const { container } = await renderView(t);
  const undo = async () => {};
  globalThis.__results.deleteSharedWords = () => {
    throw partialError("network", 1, undo);
  };
  await openList(container, `space:${ENGINEERING}`);
  await click(checkboxFor(container, "Qdrant"));
  await click(checkboxFor(container, "sherpa-onnx"));
  await click(barButton(container, "dictionary.shared.actions.deleteForEveryone"));
  await click(byAttribute(container, "data-confirm"));
  const toast = globalThis.__toasts.at(-1);
  assert.equal(
    toast.title,
    'dictionary.shared.partial.delete{"applied":1,"total":2,"count":1,"list":"Engineering"}'
  );
  assert.equal(toast.description, "dictionary.shared.share.reasons.network");
  assert.equal(toast.variant, "destructive");
  assert.equal(toast.actions[0].label, "dictionary.shared.undo");
  assert.equal(toast.duration, 6000);
});

test("Delete for everyone's Undo stays up as long as the app's other Undo toasts", async (t) => {
  const { container } = await renderView(t);
  await openList(container, `space:${ENGINEERING}`);
  await click(buttonsIn(rowFor(container, "Qdrant"))[3]);
  await click(byAttribute(container, "data-confirm"));
  assert.equal(globalThis.__toasts.at(-1).duration, 6000);
});

test("a Hide for me that stops part-way counts what went and keeps the rest selected", async (t) => {
  const { container } = await renderView(t);
  globalThis.__results.setSharedWordsHidden = () => {
    throw partialError("network", 1);
  };
  await openList(container, `space:${ENGINEERING}`);
  await click(checkboxFor(container, "Qdrant"));
  await click(checkboxFor(container, "sherpa-onnx"));
  await click(barButton(container, "dictionary.shared.actions.hide"));
  const toast = globalThis.__toasts.at(-1);
  assert.equal(
    toast.title,
    'dictionary.shared.partial.hide{"applied":1,"total":2,"count":1,"list":"Engineering"}'
  );
  assert.equal(toast.description, "dictionary.shared.share.reasons.network");
  assert.ok(toolbar(container), "the selection stays for another try");

  // Nothing applied still reads as the plain failure.
  globalThis.__results.setSharedWordsHidden = "throw:network";
  await click(barButton(container, "dictionary.shared.actions.hide"));
  assert.deepEqual(globalThis.__toasts.at(-1), {
    title: 'dictionary.shared.errors.generic{"list":"Engineering"}',
    description: undefined,
    variant: "destructive",
    duration: undefined,
    actions: undefined,
  });
});

test("an add that stops part-way counts what went in and names what was left out", async (t) => {
  const { container } = await renderView(t);
  globalThis.__results.addSharedWords = {
    added: ["Helm"],
    alreadyPresent: [],
    rejected: [],
    failed: { words: ["Argo"], reason: "listFull" },
  };
  await openList(container, "workspace");
  await type(addInput(container), "Helm, Argo, a<b");
  await pressEnter(addInput(container));
  const list = 'dictionary.shared.everyoneAt{\\"workspace\\":\\"Acme\\"}';
  const [skipped, partial] = globalThis.__toasts.slice(-2);
  assert.equal(skipped.title, 'dictionary.shared.skipped{"count":1,"words":"a<b"}');
  assert.equal(skipped.variant, "default");
  assert.equal(
    partial.title,
    `dictionary.shared.partial.add{"applied":1,"total":2,"count":1,"list":"${list}"}`
  );
  assert.equal(partial.description, `dictionary.shared.errors.listFull{"list":"${list}"}`);
  assert.equal(addInput(container).value, "Helm, Argo, a<b", "the field keeps the words to retry");
});

test("Sync records when it finished, and a failed one doesn't", async (t) => {
  const { container, calls } = await renderView(t);
  const syncButton = () => byAttribute(container, "aria-label", "dictionary.shared.toolbar.sync");
  await click(syncButton());
  assert.deepEqual(
    calls.filter(([name]) => name === "markSynced"),
    [["markSynced", 0]]
  );

  globalThis.__results.syncShared = "reject";
  await click(syncButton());
  assert.equal(calls.filter(([name]) => name === "markSynced").length, 1);
});

test("deleting or renaming a personal word a list also has says the list still has it", async (t) => {
  const { container, calls } = await renderView(t, {
    settings: { customDictionary: ["OpenWhispr", "Qdrant", "Whispr"] },
  });
  const action = (word, key) =>
    byAttribute(rowFor(container, word), "aria-label", named(key, word));
  const stillIn = 'dictionary.shared.stillIn{"word":"Qdrant","list":"Engineering"}';

  await click(action("Qdrant", "dictionary.shared.actions.deleteWord"));
  assert.deepEqual(calls.filter(([name]) => name === "updateCustomDictionary").at(-1), [
    "updateCustomDictionary",
    { remove: ["Qdrant"] },
  ]);
  assert.equal(globalThis.__toasts.at(-1).title, stillIn);

  const toasts = globalThis.__toasts.length;
  await click(action("OpenWhispr", "dictionary.shared.actions.deleteWord"));
  assert.equal(globalThis.__toasts.length, toasts, "no shared copy, no toast");

  const rename = async (word) => {
    await click(action("Qdrant", "dictionary.editWord"));
    const editor = findElement(rowFor(container, "Qdrant"), (node) => node.tagName === "INPUT");
    await type(editor, word);
    await pressEnter(editor);
  };
  await rename("Qdrant DB");
  assert.equal(globalThis.__toasts.at(-1).title, stillIn);
  assert.equal(globalThis.__toasts.length, toasts + 1);
  // A change of case keeps the personal word in front of the shared copy.
  await rename("QDRANT");
  assert.equal(globalThis.__toasts.length, toasts + 1);
});

test("paused, deleting a personal word a list has adds no toast: the list doesn't apply", async (t) => {
  const { container } = await renderView(t, {
    settings: { customDictionary: ["OpenWhispr", "Qdrant", "Whispr"] },
    shared: { snapshot: PAUSED },
  });
  await click(
    byAttribute(
      rowFor(container, "Qdrant"),
      "aria-label",
      named("dictionary.shared.actions.deleteWord", "Qdrant")
    )
  );
  assert.deepEqual(globalThis.__toasts, []);
});

test("Hide for me on a row says so, and its Undo unhides the word", async (t) => {
  const { container, calls } = await renderView(t);
  await openList(container, `space:${ENGINEERING}`);
  await click(
    byAttribute(
      rowFor(container, "Qdrant"),
      "aria-label",
      named("dictionary.shared.actions.hideWord", "Qdrant")
    )
  );
  const toast = globalThis.__toasts.at(-1);
  assert.equal(toast.title, 'dictionary.shared.hiddenWord{"word":"Qdrant"}');
  assert.equal(toast.duration, 6000);
  assert.equal(toast.actions[0].label, "dictionary.shared.undo");
  await React.act(async () => toast.actions[0].onClick());
  assert.deepEqual(calls.filter(([name]) => name === "setSharedWordsHidden").at(-1), [
    "setSharedWordsHidden",
    "ws",
    ["e-qdrant"],
    false,
  ]);

  // A hide that failed has nothing to undo.
  globalThis.__results.setSharedWordsHidden = "throw:network";
  const count = globalThis.__toasts.length;
  await click(
    byAttribute(
      rowFor(container, "Qdrant"),
      "aria-label",
      named("dictionary.shared.actions.hideWord", "Qdrant")
    )
  );
  assert.equal(globalThis.__toasts.length, count + 1);
  assert.equal(globalThis.__toasts.at(-1).variant, "destructive");
});
