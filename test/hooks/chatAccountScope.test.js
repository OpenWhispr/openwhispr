const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHappyDom,
  installHookDom,
  SIGNED_OUT_AUTH_MOCK,
} = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

// Main's account scope, as the windows hear it.
function fakeAccountScope(initial) {
  let scope = initial;
  const listeners = new Set();
  return {
    api: {
      getActiveAccountScope: async () => scope,
      onActiveAccountScopeChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit: (next) => {
      scope = next;
      listeners.forEach((listener) => listener(next));
    },
  };
}

function fakeConversations() {
  let nextRowId = 1;
  const rows = [];
  const conversations = new Map();
  const created = [];
  const get = (id) => {
    const conversation = conversations.get(id);
    return conversation
      ? { ...conversation, messages: rows.filter((row) => row.conversation_id === id) }
      : null;
  };
  const addAgentMessage = async (conversation_id, role, content, metadata) => {
    const row = {
      id: nextRowId++,
      conversation_id,
      role,
      content,
      metadata: metadata ? JSON.stringify(metadata) : null,
    };
    rows.push(row);
    return row;
  };
  return {
    rows,
    created,
    seed: async (id, title, messages) => {
      conversations.set(id, { id, title, parent_conversation_id: null });
      for (const [role, content] of messages) await addAgentMessage(id, role, content);
    },
    api: {
      claimAgentConversation: async (id) => ({ owned: true, conversation: get(id) }),
      releaseAgentConversation: async () => {},
      onAgentConversationReleased: () => () => {},
      createAgentConversation: async (title) => {
        const conversation = { id: 100 + created.length, title, parent_conversation_id: null };
        conversations.set(conversation.id, conversation);
        created.push(conversation.id);
        return conversation;
      },
      getAgentConversation: async (id) => get(id),
      addAgentMessage,
      updateAgentMessage: async (id, content, metadata) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (!row) return null;
        Object.assign(row, { content, metadata: metadata ? JSON.stringify(metadata) : null });
        return row;
      },
    },
  };
}

// The agent window stays up across a sign-out, so its chat must let go of the
// account that left. The control panel's chats follow chatTurnStore instead.
for (const [boundary, nextScope] of [
  ["another account signing in", { accountId: "account-b", authGeneration: 2 }],
  ["a sign-out", null],
  // Main's rule: any new credential ends account-bound work, the same account's too.
  ["a new credential for the same account", { accountId: "account-a", authGeneration: 2 }],
]) {
  test(`${boundary} drops the agent window's chat before its next model request`, async (t) => {
    let root;
    t.after(() => root && React.act(async () => root.unmount()));
    const scope = fakeAccountScope({ accountId: "account-a", authGeneration: 1 });
    const db = fakeConversations();
    installBrowserGlobals(t, {
      initialStorage: { isSubscribed: "true" },
      window: { electronAPI: { ...scope.api, ...db.api } },
    });
    const container = installHookDom(t);
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-agent-chat-scope-test-",
      mockModules: SIGNED_OUT_AUTH_MOCK,
    });
    const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
    t.after(() => service.destroy());
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
    useSettingsStore.setState({
      isSignedIn: true,
      cloudBackupEnabled: false,
      dictationAgentMode: "providers",
      dictationAgentProvider: "openai",
      dictationAgentModel: "gpt-5-mini",
    });
    usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
    const { useAgentChat } = await vite.ssrLoadModule("/components/agent/useAgentChat.ts");
    let chat;
    function Harness() {
      chat = useAgentChat({ onRegenerateFailed() {} });
      return null;
    }
    root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    const act = (fn) => React.act(async () => fn());

    await db.seed(7, "A's chat", [
      ["user", "A's private question"],
      ["assistant", "A's private answer"],
    ]);
    await act(() => chat.switchChat(7));
    assert.deepEqual(
      chat.messages.map((message) => message.content),
      ["A's private question", "A's private answer"]
    );

    const streaming = Promise.withResolvers();
    let signal;
    service.processTextStreamingAI = async function* (_m, _model, _p, _config, _tools, stream) {
      signal = stream;
      yield { type: "content", text: "A's private reply" };
      streaming.resolve();
      await new Promise((resolve) => stream.addEventListener("abort", resolve, { once: true }));
    };
    let sending;
    await act(async () => {
      sending = chat.send("A's private follow-up");
      await streaming.promise;
    });
    await act(() => scope.emit({ accountId: "account-a", authGeneration: 1 }));
    assert.equal(signal.aborted, false, "the same account and credential keep the reply");
    assert.equal(chat.conversationId, 7);

    await act(() => scope.emit(nextScope));
    assert.equal(signal.aborted, true, "the departed reply is cancelled");
    await act(() => sending);
    assert.deepEqual(chat.messages, []);
    assert.equal(chat.conversationId, null);
    const savedForA = db.rows.length;

    const requests = [];
    service.processTextStreamingAI = async function* (messages) {
      requests.push(JSON.stringify(messages));
      yield { type: "content", text: "The next answer" };
      yield { type: "done", finishReason: "stop" };
    };
    await act(() => chat.send("The next question"));
    assert.equal(requests.length, 1);
    assert.ok(requests[0].includes("The next question"));
    assert.equal(requests[0].includes("A's private"), false, "no departed history in the request");
    assert.deepEqual(db.created, [100], "the next request starts its own conversation");
    assert.equal(chat.conversationId, 100);
    assert.ok(
      db.rows.slice(savedForA).every((row) => row.conversation_id === 100),
      "nothing more is saved into the departed account's chat"
    );
  });
}

test("a conversation load from the departed account cannot refill the chat", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const scope = fakeAccountScope({ accountId: "account-a", authGeneration: 1 });
  let finishLoad;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        ...scope.api,
        getAgentConversation: () =>
          new Promise((resolve) => {
            finishLoad = resolve;
          }),
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t);
  const { useChatPersistence } = await vite.ssrLoadModule("/components/chat/useChatPersistence.ts");
  let chat;
  function Harness() {
    chat = useChatPersistence();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  let loading;
  await React.act(async () => {
    loading = chat.loadConversation(7);
  });
  await React.act(async () => scope.emit(null));
  await React.act(async () =>
    finishLoad({ id: 7, messages: [{ role: "user", content: "A's secret" }] })
  );
  assert.equal(await loading, false);
  assert.deepEqual(chat.messages, []);
  assert.equal(chat.conversationId, null);
});

const chatRow = (title) => ({
  id: 1,
  title,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
});

async function renderConversationList(t, electronAPI) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const pending = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAgentConversationsWithPreview: (_limit, _offset, isArchived) =>
          isArchived
            ? Promise.resolve([])
            : new Promise((resolve) => {
                pending.push(resolve);
              }),
        ...electronAPI,
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-conversation-list-scope-test-",
  });
  const store = await vite.ssrLoadModule("/stores/chatTurnStore.ts");
  const { default: ConversationList } = await vite.ssrLoadModule(
    "/components/chat/ConversationList.tsx"
  );
  const noop = () => {};
  const mount = async () => {
    root = createRoot(container);
    await React.act(async () =>
      root.render(
        React.createElement(ConversationList, {
          activeConversationId: null,
          onSelectConversation: noop,
          onNewChat: noop,
          onOpenSearch: noop,
          onArchive: noop,
          onUnarchive: noop,
          onDelete: noop,
          refreshKey: 0,
        })
      )
    );
  };
  return { container, pending, store, mount };
}

test("the chat list reloads for the next account, and a load from before it can't return", async (t) => {
  let noteUpdated;
  const { container, pending, store, mount } = await renderConversationList(t, {
    onNoteUpdated: (listener) => {
      noteUpdated = listener;
      return () => {};
    },
  });
  store.prepareChatAccountScope("account-a");
  await mount();
  await React.act(async () => pending[0]([chatRow("A's chat")]));
  assert.ok(container.textContent.includes("A's chat"));

  await React.act(async () => noteUpdated());
  assert.equal(pending.length, 2, "A's refresh is still being read");
  await React.act(async () => store.prepareChatAccountScope("account-b"));
  assert.equal(container.textContent.includes("A's chat"), false, "the list empties at once");
  assert.equal(pending.length, 3, "the list reads again for the new account");
  await React.act(async () => pending[2]([chatRow("B's chat")]));
  await React.act(async () => pending[1]([chatRow("A's late chat")]));
  assert.ok(container.textContent.includes("B's chat"));
  assert.equal(container.textContent.includes("A's late chat"), false);
});

// A launch that restored no scope learns its first one without an account
// generation change, yet the rows main returns change with it.
test("the chat list follows the first account scope, and a load from before it can't return", async (t) => {
  const scope = fakeAccountScope(null);
  const { container, pending, store, mount } = await renderConversationList(t, scope.api);
  t.after(store.subscribeChatAccountScope());
  await mount();
  assert.equal(pending.length, 1);
  const generation = store.useChatTurnStore.getState().accountGeneration;
  await React.act(async () => scope.emit({ accountId: "account-a", authGeneration: 2 }));
  assert.equal(store.useChatTurnStore.getState().accountGeneration, generation);
  assert.equal(pending.length, 2, "the list reads again for the account");
  await React.act(async () => pending[1]([chatRow("A's chat")]));
  await React.act(async () => pending[0]([chatRow("the guest's chat")]));
  assert.ok(container.textContent.includes("A's chat"));
  assert.equal(container.textContent.includes("the guest's chat"), false);
});

const MENU_MOCK = {
  "/ui/dropdown-menu": `
    import { createElement } from "react";
    export function DropdownMenu({ open, onOpenChange, children }) {
      globalThis.__chatSwitcher = { open, onOpenChange };
      return createElement("div", { "data-menu": "" }, open ? children : null);
    }
    const part = ({ children }) => createElement("div", null, children);
    export const DropdownMenuTrigger = part;
    export const DropdownMenuContent = part;
    export const DropdownMenuItem = part;
    export const DropdownMenuLabel = part;
  `,
};

test("the agent window's chat switcher forgets the departed account's chats", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__chatSwitcher;
  });
  const dom = await installHappyDom(t);
  const scope = fakeAccountScope({ accountId: "account-a", authGeneration: 1 });
  const pending = [];
  dom.electronAPI = {
    ...scope.api,
    getAgentConversationsWithPreview: () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-agent-modal-scope-test-",
    mockModules: MENU_MOCK,
  });
  const { AgentModal } = await vite.ssrLoadModule("/components/agent/AgentModal.tsx");
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  root = createRoot(host);
  await React.act(async () =>
    root.render(
      React.createElement(AgentModal, {
        bare: false,
        glow: "none",
        conversationId: null,
        onNewChat() {},
        onSelectChat() {},
        onCollapse() {},
        children: "Conversation",
        footer: "Input",
      })
    )
  );
  const menu = () => host.querySelector("[data-menu]").textContent;
  const setOpen = (open) => React.act(async () => globalThis.__chatSwitcher.onOpenChange(open));

  await setOpen(true);
  await React.act(async () => pending[0]([chatRow("A's chat")]));
  assert.ok(menu().includes("A's chat"));
  await setOpen(false);
  await setOpen(true);
  assert.equal(pending.length, 2, "A's list is being read again");

  await React.act(async () => scope.emit({ accountId: "account-b", authGeneration: 2 }));
  assert.equal(globalThis.__chatSwitcher.open, false, "the open menu closes");
  await setOpen(true);
  assert.equal(menu().includes("A's chat"), false, "the last list is gone before B's arrives");
  await React.act(async () => pending[1]([chatRow("A's late chat")]));
  assert.equal(menu().includes("A's late chat"), false);
  await React.act(async () => pending[2]([chatRow("B's chat")]));
  assert.ok(menu().includes("B's chat"));
});
