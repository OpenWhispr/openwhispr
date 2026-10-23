const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  SIGNED_OUT_AUTH_MOCK,
} = require("../lib/rendererTestHarness");

// useChatPersistence mounted for real against an in-memory stand-in for the
// conversation IPC: ids, in-place updates, waiting replies and forks.
function fakeDb() {
  let nextId = 1;
  const rows = [];
  const conversations = new Map();
  const owners = new Map();
  const released = new Set();
  const scopeListeners = new Set();
  const writes = [];
  let accountId = "account-a";
  const calls = { add: [], update: [], fork: [], title: [] };
  const get = (id) => {
    const conversation = conversations.get(id);
    if (!conversation) return null;
    const parent = conversations.get(conversation.parent_conversation_id);
    return {
      ...conversation,
      parent_title: parent?.title ?? null,
      messages: rows.filter((row) => row.conversation_id === id),
    };
  };
  const api = {
    getActiveAccountScope: async () => ({ accountId, authGeneration: 1 }),
    onActiveAccountScopeChanged: (listener) => {
      scopeListeners.add(listener);
      return () => scopeListeners.delete(listener);
    },
    claimAgentConversation: async (id, owner) => {
      const owned = !owners.has(id) || owners.get(id) === owner;
      if (owned) owners.set(id, owner);
      return { owned, conversation: get(id) };
    },
    releaseAgentConversation: async (id, owner) => {
      if (owners.get(id) !== owner) return;
      owners.delete(id);
      for (const listener of released) listener({ conversationId: id });
    },
    onAgentConversationReleased: (listener) => {
      released.add(listener);
      return () => released.delete(listener);
    },
    createAgentConversation: async (title) => {
      const conversation = { id: 100 + conversations.size, title, parent_conversation_id: null };
      conversations.set(conversation.id, conversation);
      return conversation;
    },
    getAgentConversation: async (id) => {
      const conversation = get(id);
      return conversation ? { ...conversation, has_active_turn: owners.has(id) } : null;
    },
    addAgentMessage: async (conversation_id, role, content, metadata) => {
      calls.add.push({ conversation_id, role, content, metadata });
      writes.push({ operation: "add", accountId });
      const row = {
        id: nextId++,
        conversation_id,
        role,
        content,
        metadata: metadata ? JSON.stringify(metadata) : null,
      };
      rows.push(row);
      return row;
    },
    updateAgentMessage: async (id, content, metadata) => {
      calls.update.push({ id, content, metadata });
      writes.push({ operation: "update", accountId });
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      Object.assign(row, { content, metadata: metadata ? JSON.stringify(metadata) : null });
      return row;
    },
    updateAgentConversationTitle: async (id, title) => {
      calls.title.push({ id, title });
      conversations.get(id).title = title;
      return { success: true };
    },
    forkAgentConversation: async (conversationId, throughId, context) => {
      calls.fork.push({ conversationId, throughId, context });
      const source = conversations.get(conversationId);
      const copied = rows.filter((r) => r.conversation_id === conversationId && r.id <= throughId);
      const fork = {
        id: 100 + conversations.size,
        title: source.title,
        parent_conversation_id: conversationId,
        fork_message_count: copied.length,
        fork_context: context,
      };
      conversations.set(fork.id, fork);
      for (const row of copied) {
        rows.push({ ...row, id: nextId++, conversation_id: fork.id });
      }
      return get(fork.id);
    },
  };
  return {
    api,
    rows,
    calls,
    conversations,
    writes,
    emitScope: (scope) => {
      accountId = scope?.accountId ?? null;
      scopeListeners.forEach((listener) => listener(scope));
    },
  };
}

async function mountPersistence(
  t,
  { instances = 1, restore = false, streaming = false, senderConversationId } = {}
) {
  const db = fakeDb();
  let root;
  // Node runs after hooks in registration order: unmount while the DOM exists.
  t.after(() => root && React.act(async () => root.unmount()));
  installBrowserGlobals(t, {
    initialStorage: { isSubscribed: "true" },
    window: { electronAPI: db.api },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-persistence-test-",
    mockModules: SIGNED_OUT_AUTH_MOCK,
  });
  const { useChatPersistence } = await vite.ssrLoadModule("/components/chat/useChatPersistence.ts");
  const { createRoot } = require("react-dom/client");
  const { useInterruptedInteractions } = await vite.ssrLoadModule(
    "/components/chat/useInterruptedInteractions.ts"
  );
  const store = await vite.ssrLoadModule("/stores/agentInteractionStore.ts");
  store.useAgentInteractionStore.setState({ entries: {} });
  const persistence = [];
  const sent = [];
  const streams = [];
  const senders = [];
  let useChatStreaming, useChatMessageSender, service;
  if (streaming) {
    ({ useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts"));
    ({ useChatMessageSender } = await vite.ssrLoadModule(
      "/components/chat/useChatMessageSender.ts"
    ));
    service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
    t.after(() => service.destroy());
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
    useSettingsStore.setState({
      isSignedIn: true,
      cloudBackupEnabled: false,
      chatAgentMode: "providers",
      chatAgentProvider: "openai",
      chatAgentModel: "gpt-5-mini",
    });
    usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  }
  function Harness({ index }) {
    const value = useChatPersistence();
    persistence[index] = value;
    if (streaming) {
      const stream = useChatStreaming({
        setMessages: value.setMessages,
        allowInteractions: true,
        allowConnectors: true,
        onStreamComplete: value.saveAssistantMessage,
        onTurnCheckpoint: value.saveAssistantMessage,
        claimConversation: value.claimConversation,
      });
      streams[index] = stream;
      senders[index] = useChatMessageSender({
        conversationId: senderConversationId ?? value.conversationId,
        persistence: value,
        streaming: stream,
        createConversation: (text) => value.createConversation(text),
      });
    }
    if (restore)
      useInterruptedInteractions(value, async (text) => {
        sent.push([index, text]);
        return true;
      });
    return null;
  }
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        ...Array.from({ length: instances }, (_, index) =>
          React.createElement(Harness, { key: index, index })
        )
      )
    )
  );
  const act = (fn) => React.act(async () => fn());
  return {
    db,
    act,
    current: (index = 0) => persistence[index],
    store,
    sent,
    vite,
    service,
    stream: () => streams[0],
    send: (...args) => senders[0](...args),
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

const message = (id, role, content, extra = {}) => ({
  id,
  role,
  content,
  isStreaming: false,
  ...extra,
});

test("saved messages carry their row id, and a waiting reply is completed in place", async (t) => {
  const { db, act, current } = await mountPersistence(t);
  await act(() => current().createConversation("Plan"));
  await act(() =>
    current().setMessages([message("u1", "user", "Hi"), message("a1", "assistant", "")])
  );
  await act(() => current().saveUserMessage("Hi", { messageId: "u1", selectedContext: "quoted" }));

  const waitingTurn = { startedAt: 1, status: "waiting" };
  const pendingCall = {
    id: "q1",
    name: "ask_user",
    arguments: "{}",
    status: "executing",
    interaction: { payload: { kind: "questions", questions: [] }, state: "pending" },
  };
  // The final save races the waiting one; it still updates the same row.
  await act(() => {
    void current().saveAssistantMessage("a1", "", [pendingCall], { turn: waitingTurn });
    return current().saveAssistantMessage("a1", "Done.", [pendingCall], {
      turn: { startedAt: 1, finishedAt: 2, status: "complete" },
    });
  });

  assert.deepEqual(
    db.calls.add.map((call) => [call.role, call.metadata]),
    [
      ["user", { selectedContext: "quoted" }],
      ["assistant", { toolCalls: [pendingCall], turn: waitingTurn }],
    ]
  );
  assert.equal(db.calls.update.length, 1);
  assert.equal(db.calls.update[0].content, "Done.");
  const messages = current().messages;
  assert.deepEqual(
    messages.map((m) => m.dbId),
    [1, 2]
  );
});

test("a reply saves into the conversation its turn ran in, even after a switch", async (t) => {
  const { db, act, current } = await mountPersistence(t);
  await act(() => current().createConversation("First"));
  await act(() => current().handleNewChat());
  await act(() =>
    current().saveAssistantMessage("a1", "Partial", undefined, {
      turn: { startedAt: 1, status: "stopped" },
      conversationId: 100,
    })
  );
  assert.equal(db.calls.add[0].conversation_id, 100);
});

test("a reply saved while waiting loads as interrupted, so it can still be answered", async (t) => {
  const { db, act, current } = await mountPersistence(t);
  const conversation = await db.api.createAgentConversation("Plan");
  await db.api.addAgentMessage(conversation.id, "assistant", "One question first.", {
    turn: { startedAt: 1, status: "waiting" },
    toolCalls: [
      {
        id: "q1",
        name: "ask_user",
        arguments: "{}",
        status: "executing",
        interaction: { payload: { kind: "questions", questions: [] }, state: "pending" },
      },
    ],
  });
  await act(() => current().loadConversation(conversation.id));

  const [loaded] = current().messages;
  assert.equal(loaded.dbId, 1);
  assert.equal(loaded.turn.status, "interrupted");
  assert.equal(loaded.toolCalls[0].interaction.state, "interrupted");
  assert.equal(loaded.toolCalls[0].status, "stopped", "never a step stuck asking");
  assert.equal(current().forkOrigin, null);
});

test("a reply saved mid-turn loads as stopped, with every call it had running", async (t) => {
  const { db, act, current } = await mountPersistence(t);
  const conversation = await db.api.createAgentConversation("Plan");
  await db.api.addAgentMessage(conversation.id, "assistant", "Posting it.", {
    turn: { startedAt: 1, status: "running" },
    toolCalls: [{ id: "s1", name: "slack_send_message", arguments: "{}", status: "executing" }],
  });
  await act(() => current().loadConversation(conversation.id));

  const [loaded] = current().messages;
  assert.equal(loaded.turn.status, "stopped");
  assert.equal(loaded.toolCalls[0].status, "stopped");
});

test("a reply whose row a cloud pull replaced is saved again as a new row", async (t) => {
  const { db, act, current } = await mountPersistence(t);
  await act(() => current().createConversation("Plan"));
  await act(() => current().setMessages([message("a1", "assistant", "")]));
  await act(() => current().saveAssistantMessage("a1", "Waiting.", undefined, {}));
  db.rows.splice(0);
  await act(() => current().saveAssistantMessage("a1", "Done.", undefined, {}));

  assert.deepEqual(
    db.calls.add.map((call) => call.content),
    ["Waiting.", "Done."]
  );
  assert.equal(current().messages[0].dbId, 2);
});

test("a fork opens a new chat through the chosen reply, with its origin", async (t) => {
  const { db, act, current } = await mountPersistence(t);
  const conversation = await db.api.createAgentConversation("Launch plan");
  await db.api.addAgentMessage(conversation.id, "user", "Draft it");
  await db.api.addAgentMessage(conversation.id, "assistant", "Draft one.");
  await db.api.addAgentMessage(conversation.id, "user", "Shorter");
  await act(() => current().loadConversation(conversation.id));

  const unsaved = message("x", "assistant", "Not saved");
  assert.equal(await current().forkConversation(unsaved), null, "an unsaved reply can't be forked");

  let forkId;
  await act(async () => {
    forkId = await current().forkConversation(current().messages[1], "Draft one.");
  });
  assert.notEqual(forkId, conversation.id);
  assert.deepEqual(db.calls.fork, [
    { conversationId: conversation.id, throughId: 2, context: "Draft one." },
  ]);
  assert.equal(current().conversationId, forkId);
  assert.deepEqual(
    current().messages.map((m) => m.content),
    ["Draft it", "Draft one."]
  );
  assert.deepEqual(current().forkOrigin, {
    parentConversationId: conversation.id,
    parentTitle: "Launch plan",
    title: "Launch plan",
    context: "Draft one.",
    copiedMessageCount: 2,
  });
});

test("a fork the user left before it finished reports that, not a failure", async (t) => {
  const { db, act, current } = await mountPersistence(t);
  const conversation = await db.api.createAgentConversation("Launch plan");
  await db.api.addAgentMessage(conversation.id, "assistant", "Draft one.");
  await act(() => current().loadConversation(conversation.id));
  let finishFork;
  const fork = db.api.forkAgentConversation;
  db.api.forkAgentConversation = (...args) =>
    new Promise((resolve) => (finishFork = () => resolve(fork(...args))));

  let result;
  await act(async () => {
    const forking = current().forkConversation(current().messages[0]);
    current().handleNewChat();
    finishFork();
    result = await forking;
  });
  assert.equal(result, false);
  assert.equal(current().conversationId, null, "the new chat stays open");
});

// The agent window's chat, with the reply itself stood in for.
async function mountAgentChat(t) {
  const db = fakeDb();
  let root;
  t.after(() => root && React.act(async () => root.unmount()));
  installBrowserGlobals(t, { window: { electronAPI: db.api } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-persistence-test-",
    mockModules: {
      "/useChatStreaming": `
        export function useChatStreaming() {
          return { agentState: "idle", cancelStream() {}, sendToAI: async () => {} };
        }
      `,
      // The send an answer to a card left from an earlier turn goes on with.
      "/useInterruptedInteractions": `
        export function useInterruptedInteractions(_persistence, send) {
          globalThis.__sendFollowUp = send;
        }
      `,
    },
  });
  const { useAgentChat } = await vite.ssrLoadModule("/components/agent/useAgentChat.ts");
  const { createRoot } = require("react-dom/client");
  let chat;
  function Harness() {
    chat = useAgentChat({ onRegenerateFailed() {} });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const act = (fn) => React.act(async () => fn());
  return { db, act, current: () => chat };
}

// A chat with one reply, and a fork of it, open.
async function openFork(db, act, current) {
  await act(() => current().send("Draft the launch plan"));
  const parentId = current().conversationId;
  await db.api.addAgentMessage(parentId, "assistant", "Draft one.");
  await act(() => current().switchChat(parentId));
  await act(() => current().fork(current().messages[1]));
  assert.notEqual(current().conversationId, parentId);
  return { parentId, forkId: current().conversationId };
}

test("a fork takes its title from the first message the user writes in it", async (t) => {
  const { db, act, current } = await mountAgentChat(t);
  const { parentId, forkId } = await openFork(db, act, current);

  await act(() => current().send("Make it shorter"));
  await act(() => current().send("And friendlier"));

  assert.deepEqual(db.calls.title, [{ id: forkId, title: "Make it shorter" }]);
  assert.equal(db.conversations.get(parentId).title, "Draft the launch plan");
});

test("a fork is never named by an answer the app sends on, nor once it was renamed", async (t) => {
  const { db, act, current } = await mountAgentChat(t);
  const { forkId } = await openFork(db, act, current);
  await act(() => globalThis.__sendFollowUp("Who should it go to?\nSam"));
  assert.deepEqual(db.calls.title, [], "the answer to a copied card");

  await act(() => current().newChat());
  const { forkId: renamedId } = await openFork(db, act, current);
  assert.notEqual(renamedId, forkId);
  db.conversations.get(renamedId).title = "Launch, short version";
  await act(() => current().switchChat(renamedId));
  await act(() => current().send("Make it shorter"));
  assert.deepEqual(db.calls.title, [], "renamed before its first message");
});

async function waitingConversation(db) {
  const conversation = await db.api.createAgentConversation("Waiting");
  await db.api.addAgentMessage(conversation.id, "assistant", "", {
    turn: { startedAt: 1, status: "waiting" },
    toolCalls: [
      {
        id: "q",
        name: "ask_user",
        arguments: "{}",
        status: "executing",
        interaction: {
          state: "pending",
          payload: {
            kind: "questions",
            questions: [{ id: "city", kind: "text", prompt: "Which city?" }],
          },
        },
      },
    ],
  });
  return conversation.id;
}

test("a live peer's waiting conversation cannot be recovered until its owner leaves", async (t) => {
  const chat = await mountPersistence(t, { restore: true });
  const id = await waitingConversation(chat.db);
  await chat.db.api.claimAgentConversation(id, "live-peer");
  await chat.act(() => chat.current().loadConversation(id));
  assert.deepEqual(chat.store.useAgentInteractionStore.getState().entries, {});
  assert.equal(chat.current().messages[0].turn.status, "waiting");
  assert.equal(
    await chat.current().claimConversation(id),
    false,
    "a typed send cannot take over either"
  );
  await chat.act(() => chat.db.api.releaseAgentConversation(id, "live-peer"));
  const entries = Object.values(chat.store.useAgentInteractionStore.getState().entries);
  assert.equal(entries.length, 1, "an interrupted wait becomes answerable after owner exit");
  assert.equal(entries[0].restored, true);
});

test("simultaneous recovery exposes one answer and peers reload its saved outcome", async (t) => {
  const chat = await mountPersistence(t, { instances: 2, restore: true });
  const id = await waitingConversation(chat.db);
  await chat.act(() =>
    Promise.all([chat.current(0).loadConversation(id), chat.current(1).loadConversation(id)])
  );
  const entries = Object.values(chat.store.useAgentInteractionStore.getState().entries);
  assert.equal(entries.length, 1);
  await chat.act(() => {
    chat.store.updateInteractionDraft(entries[0].key, { city: "Lisbon" });
    chat.store.answerQuestions(entries[0].key);
  });
  assert.equal(chat.sent.length, 1);
  await chat.act(() => chat.current(0).releaseConversation(id));
  assert.equal(chat.current(1).messages[0].toolCalls[0].interaction.state, "settled");
  assert.equal(
    Object.values(chat.store.useAgentInteractionStore.getState().entries).filter(
      (entry) => entry.state === "pending"
    ).length,
    0
  );
});

test("account and credential boundaries stop a live question without writing its continuation", async (t) => {
  for (const boundary of ["account", "generation", "scopeGeneration", "signout"]) {
    await t.test(boundary, async (t) => {
      const h = await mountPersistence(t, { streaming: true, senderConversationId: 100 });
      const auth = await h.vite.ssrLoadModule("/lib/authRequestContext.ts");
      await h.act(() => auth.observeAuthTokenStateEvent({ generation: 1, hasToken: true }));
      let signal;
      h.service.processTextStreamingAI = async function* (_m, _model, _p, config, tools) {
        signal = config.signal;
        yield {
          type: "tool_calls",
          calls: [{ id: "question", name: "ask_user", arguments: "{}" }],
        };
        await tools.ask_user.execute(
          { questions: [{ id: "city", kind: "text", prompt: "City?" }] },
          { toolCallId: "question", messages: [] }
        );
        yield { type: "content", text: "Old task continued" };
      };
      let sending;
      await h.act(async () => {
        sending = h.send("Plan the trip");
        await new Promise(setImmediate);
      });
      assert.equal(h.current().messages.at(-1).turn.status, "waiting");
      const version = h.current().getSessionVersion();
      await h.act(() => {
        auth.observeAuthTokenStateEvent({ generation: 1, hasToken: true });
        h.db.emitScope({ accountId: "account-a", authGeneration: 1 });
      });
      assert.equal(signal.aborted, false, "unchanged credentials and account keep the turn");
      assert.equal(h.current().getSessionVersion(), version);
      const writes = h.db.writes.length;
      await h.act(async () => {
        if (boundary === "generation")
          auth.observeAuthTokenStateEvent({ generation: 2, hasToken: true });
        else if (boundary === "scopeGeneration")
          h.db.emitScope({ accountId: "account-a", authGeneration: 2 });
        else
          h.db.emitScope(
            boundary === "signout" ? null : { accountId: "account-b", authGeneration: 1 }
          );
      });
      assert.equal(signal.aborted, true);
      await h.act(() => sending);
      assert.ok(h.current().getSessionVersion() > version);
      assert.equal(h.current().conversationId, null);
      assert.deepEqual(h.current().messages, []);
      assert.equal(
        h.db.writes.length,
        writes,
        "the old turn cannot checkpoint or complete under the new context"
      );
      assert.ok(
        Object.values(h.store.useAgentInteractionStore.getState().entries).every(
          (entry) => entry.state === "settled"
        )
      );
      h.service.processTextStreamingAI = async function* () {
        yield { type: "content", text: "New account reply" };
        yield { type: "done", finishReason: "stop" };
      };
      await h.act(() => h.send("New account task"));
      assert.equal(
        h.current().conversationId,
        101,
        "a stale parent selection cannot reuse A's conversation"
      );
      assert.equal(h.db.rows.filter((row) => row.conversation_id === 100).length, 2);
    });
  }
});

test("a deferred reply save cannot run its queued update after an account boundary", async (t) => {
  const h = await mountPersistence(t);
  await h.act(() => h.current().createConversation("A task"));
  await h.act(() => h.current().saveAssistantMessage("a1", "first"));
  const update = h.db.api.updateAgentMessage;
  let finish;
  h.db.api.updateAgentMessage = async (...args) => {
    const result = await update(...args);
    return new Promise((resolve) => {
      finish = () => resolve(result);
    });
  };
  let first, queued;
  await h.act(async () => {
    first = h.current().saveAssistantMessage("a1", "started under A");
    queued = h.current().saveAssistantMessage("a1", "queued under A");
    await new Promise(setImmediate);
  });
  await h.act(async () => {
    h.db.emitScope({ accountId: "account-b", authGeneration: 2 });
    finish();
    await new Promise(setImmediate);
  });
  assert.equal(h.db.calls.update.length, 1);
  await h.act(() => Promise.all([first, queued]));
  assert.ok(h.db.writes.every((write) => write.accountId === "account-a"));
  assert.equal(h.db.rows[0].content, "started under A");
});

test("a send landing after an account switch cannot checkpoint into the replacement account", async (t) => {
  for (const unmounted of [false, true])
    await t.test(unmounted ? "after unmount" : "mounted", async (t) => {
      let finishCommit, turnSignal;
      t.after(() => finishCommit?.());
      const h = await mountPersistence(t, { streaming: true });
      const { useConnectorStatusStore } = await h.vite.ssrLoadModule(
        "/stores/connectorStatusStore.ts"
      );
      useConnectorStatusStore.setState({
        loaded: true,
        statuses: {
          slack: {
            id: "slack",
            connected: true,
            configured: true,
            needsReconnect: false,
            accountLabel: "A",
            workspaceLabel: "Fixture",
          },
        },
      });
      h.db.api.connectorPrepare = async () => ({
        status: "ready",
        actionId: "late-a",
        preview: { verbKey: "post", destinationLabel: "#eng", accountLabel: "A", body: "hi" },
      });
      h.db.api.connectorCommit = () =>
        new Promise((resolve) => {
          finishCommit = () => resolve({ state: "sent", url: "https://fixture.invalid/sent" });
        });
      h.service.processTextStreamingAI = async function* (_m, _model, _p, config, tools) {
        turnSignal = config.signal;
        yield {
          type: "tool_calls",
          calls: [{ id: "send", name: "slack_send_message", arguments: "{}" }],
        };
        void tools.slack_send_message.execute(
          { destination: "#eng", text: "hi" },
          { toolCallId: "send", messages: [] }
        );
        await new Promise((resolve) =>
          config.signal.addEventListener("abort", resolve, { once: true })
        );
      };
      let sending;
      await h.act(async () => {
        sending = h.send("Post hi");
        await new Promise(setImmediate);
      });
      const approvals = await h.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
      const [key] = Object.keys(approvals.useConnectorApprovalStore.getState().entries);
      await h.act(async () => {
        void approvals.approveAction(key);
        await new Promise(setImmediate);
      });
      if (unmounted) await h.unmount();
      if (unmounted) await sending;
      const writes = h.db.writes.length;
      const auth = await h.vite.ssrLoadModule("/lib/authRequestContext.ts");
      await h.act(async () => {
        if (unmounted) auth.observeAuthTokenStateEvent({ generation: 2, hasToken: true });
        else h.db.emitScope({ accountId: "account-b", authGeneration: 2 });
      });
      assert.equal(turnSignal.aborted, true);
      await h.act(async () => {
        await sending;
        finishCommit();
        await new Promise(setImmediate);
      });
      assert.equal(h.db.writes.length, writes);
      if (!unmounted) assert.equal(h.current().conversationId, null);
    });
});

test("sync defers both the user-only preparation gap and a held real lookup until its reply is saved", async (t) => {
  let resumePreparation, resumeLookup, preparationStarted, lookupStarted;
  t.after(() => {
    resumePreparation?.();
    resumeLookup?.();
  });
  const h = await mountPersistence(t, { streaming: true });
  const preparing = new Promise((resolve) => {
    preparationStarted = resolve;
  });
  const looking = new Promise((resolve) => {
    lookupStarted = resolve;
  });
  const preparationGate = new Promise((resolve) => {
    resumePreparation = resolve;
  });
  const lookupGate = new Promise((resolve) => {
    resumeLookup = resolve;
  });
  h.db.api.getSpaces = async () => [];
  h.db.api.semanticSearchNotes = async (query) => {
    if (query === "Look up the project") {
      preparationStarted();
      await preparationGate;
    } else {
      lookupStarted();
      await lookupGate;
    }
    return [];
  };
  h.service.processTextStreamingAI = async function* (_m, _model, _p, _config, tools) {
    yield {
      type: "tool_calls",
      calls: [{ id: "lookup", name: "search_notes", arguments: '{"query":"needle"}' }],
    };
    await tools.search_notes.execute({ query: "needle" }, { toolCallId: "lookup", messages: [] });
    yield { type: "reasoning", text: "Private connector fact" };
    yield { type: "content", text: "No matching notes" };
    yield { type: "done", finishReason: "stop" };
  };
  const { SyncService } = await h.vite.ssrLoadModule("/services/SyncService.ts");
  const { ConversationsService } = await h.vite.ssrLoadModule("/services/ConversationsService.ts");
  const uploads = [];
  ConversationsService.create = async (input) => {
    uploads.push(input);
    return { id: `cloud-${uploads.length}` };
  };
  h.db.api.acknowledgeConversationCreate = async () => ({ success: true, outcome: "synced" });
  const sync = new SyncService();
  let sending;
  await h.act(async () => {
    sending = h.send("Look up the project");
    await preparing;
  });
  const id = h.current().conversationId;
  assert.equal(h.db.rows.length, 1, "only the user is saved before preparation finishes");
  await sync.pushConversation(id);
  assert.equal(uploads.length, 0, "main's live claim covers the gap before the checkpoint");
  await h.act(async () => {
    resumePreparation();
    await looking;
  });
  assert.equal(JSON.parse(h.db.rows[1].metadata).turn.status, "running");
  await sync.pushConversation(id);
  assert.equal(uploads.length, 0, "the held real search tool still owns its conversation");
  await h.act(async () => {
    resumeLookup();
    await sending;
  });
  await sync.pushConversation(id);
  assert.deepEqual(
    uploads[0].messages.map((message) => message.content),
    ["Look up the project", "No matching notes"]
  );
  assert.equal(uploads[0].messages[1].metadata.turn.reasoning, undefined);
  assert.equal(JSON.parse(h.db.rows[1].metadata).turn.reasoning, "Private connector fact");
});

test("Stop during the initial checkpoint settles the saved running row before releasing ownership", async (t) => {
  let finishSave;
  t.after(() => finishSave?.());
  const h = await mountPersistence(t, { streaming: true });
  const add = h.db.api.addAgentMessage;
  let started;
  const saving = new Promise((resolve) => {
    started = resolve;
  });
  h.db.api.addAgentMessage = async (...args) => {
    const row = await add(...args);
    if (args[1] !== "assistant") return row;
    started();
    return new Promise((resolve) => {
      finishSave = () => resolve(row);
    });
  };
  let modelStarted = false;
  h.service.processTextStreamingAI = async function* () {
    modelStarted = true;
    yield { type: "done", finishReason: "stop" };
  };
  let sending;
  await h.act(async () => {
    sending = h.send("Look up a note");
    await saving;
  });
  const id = h.current().conversationId;
  await h.act(async () => {
    h.stream().cancelStream();
    finishSave();
    await sending;
  });
  assert.equal(modelStarted, false);
  assert.equal(JSON.parse(h.db.rows[1].metadata).turn.status, "stopped");
  assert.equal((await h.db.api.getAgentConversation(id)).has_active_turn, false);
});
