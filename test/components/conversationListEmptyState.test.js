const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { chat } = require("../../src/locales/en/translation.json");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

const ARCHIVED_CHAT = {
  id: 1,
  title: "Trip planning",
  last_message: "Booked",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  archived_at: "2026-09-02T00:00:00.000Z",
};

async function renderConversationList(t, { active, archived }) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAgentConversationsWithPreview: async (_limit, _offset, isArchived) =>
          isArchived ? archived : active,
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-conversation-list-empty-test-",
  });
  const { default: ConversationList } = await vite.ssrLoadModule(
    "/components/chat/ConversationList.tsx"
  );
  root = createRoot(container);
  const noop = () => {};
  await React.act(async () =>
    root.render(
      React.createElement(ConversationList, {
        activeConversationId: null,
        onSelectConversation: noop,
        onNewChat: noop,
        onOpenSearch: noop,
        onArchive: noop,
        onDelete: noop,
        refreshKey: 0,
      })
    )
  );
  return container;
}

test("with every chat archived, the list says so instead of showing nothing", async (t) => {
  const container = await renderConversationList(t, { active: [], archived: [ARCHIVED_CHAT] });
  assert.ok(container.textContent.includes(chat.allArchived));
  assert.equal(container.textContent.includes(chat.noConversations), false);
});

test("with no chats at all, the list shows its empty state", async (t) => {
  const container = await renderConversationList(t, { active: [], archived: [] });
  assert.ok(container.textContent.includes(chat.noConversations));
});

test("a background refresh keeps the rows and buttons in place", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const ROW = { ...ARCHIVED_CHAT, title: "Budget review", archived_at: null };
  let held = null;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAgentConversationsWithPreview: (_limit, _offset, isArchived) =>
          held ? held.promise : Promise.resolve(isArchived ? [] : [ROW]),
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-conversation-list-empty-test-",
  });
  const { useChatTurnStore, resetForAccountChange } = await vite.ssrLoadModule(
    "/stores/chatTurnStore.ts"
  );
  const { default: ConversationList } = await vite.ssrLoadModule(
    "/components/chat/ConversationList.tsx"
  );
  root = createRoot(container);
  const noop = () => {};
  await React.act(async () =>
    root.render(
      React.createElement(ConversationList, {
        activeConversationId: null,
        onSelectConversation: noop,
        onNewChat: noop,
        onOpenSearch: noop,
        onArchive: noop,
        onDelete: noop,
        refreshKey: 0,
      })
    )
  );
  const newChatLabel = chat.newChat;
  const before = container.textContent;
  assert.ok(before.includes(newChatLabel), "the list has rendered");

  let release;
  held = { promise: new Promise((resolve) => (release = resolve)) };
  await React.act(async () =>
    useChatTurnStore.setState((state) => ({ listRevision: state.listRevision + 1 }))
  );
  assert.equal(container.textContent, before, "nothing leaves the screen during the refresh");
  await React.act(async () => {
    release([]);
    await held.promise;
  });

  held = { promise: new Promise((resolve) => (release = resolve)) };
  await React.act(async () => resetForAccountChange());
  assert.equal(
    container.textContent.includes(newChatLabel),
    false,
    "another account's first load still shows its loading state"
  );
  await React.act(async () => {
    release([]);
    await held.promise;
  });
});

test("a background reorder keeps an open menu attached to its conversation", async (t) => {
  const { Window } = await import("happy-dom");
  const dom = new Window();
  const globals = {
    window: dom,
    localStorage: dom.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  };
  for (const name of [
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "MutationObserver",
    "getComputedStyle",
    "CustomEvent",
    "HTMLInputElement",
  ]) {
    globals[name] = dom[name];
  }
  const originals = Object.fromEntries(
    Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  );
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  Object.defineProperty(dom.HTMLElement.prototype, "offsetHeight", { get: () => 600 });
  Object.defineProperty(dom.HTMLElement.prototype, "offsetWidth", { get: () => 300 });

  let rows = [
    { ...ARCHIVED_CHAT, id: 1, title: "Chat A", archived_at: null },
    { ...ARCHIVED_CHAT, id: 2, title: "Chat B", archived_at: null },
  ];
  dom.electronAPI = {
    getAgentConversationsWithPreview: async (_limit, _offset, isArchived) =>
      isArchived ? [] : rows,
  };
  const vite = await createRendererServer(t);
  const { useChatTurnStore } = await vite.ssrLoadModule("/stores/chatTurnStore.ts");
  const { default: ConversationList } = await vite.ssrLoadModule(
    "/components/chat/ConversationList.tsx"
  );
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  root = createRoot(container);
  const deleted = [];
  const noop = () => {};
  await React.act(async () =>
    root.render(
      React.createElement(ConversationList, {
        activeConversationId: null,
        onSelectConversation: noop,
        onNewChat: noop,
        onOpenSearch: noop,
        onArchive: noop,
        onDelete: (id) => deleted.push(id),
        refreshKey: 0,
      })
    )
  );
  const trigger = container.querySelector('[aria-haspopup="menu"]');
  await React.act(async () =>
    trigger.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  );

  rows = [rows[1], rows[0]];
  await React.act(async () =>
    useChatTurnStore.setState((state) => ({ listRevision: state.listRevision + 1 }))
  );
  const deleteItem = [...dom.document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === chat.delete
  );
  await React.act(async () => deleteItem.click());
  assert.deepEqual(deleted, [1]);
});
