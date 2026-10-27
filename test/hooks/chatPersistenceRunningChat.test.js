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
  {
    instances = 1,
    restore = false,
    streaming = false,
    agent = false,
    senderConversationId,
    mockStreaming,
  } = {}
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
  if (mockStreaming) await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
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
  const chats = [];
  const regenerationFailures = [];
  let useChatStreaming, useChatMessageSender, useAgentChat, service;
  if (streaming || mockStreaming) {
    ({ useChatMessageSender } = await vite.ssrLoadModule(
      "/components/chat/useChatMessageSender.ts"
    ));
  }
  if (streaming) {
    ({ useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts"));
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
  if (agent) {
    ({ useAgentChat } = await vite.ssrLoadModule("/components/agent/useAgentChat.ts"));
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    useSettingsStore.setState({
      dictationAgentMode: "providers",
      dictationAgentProvider: "openai",
      dictationAgentModel: "gpt-5-mini",
    });
  }
  function Harness({ index }) {
    if (agent) {
      chats[index] = useAgentChat({ onRegenerateFailed: () => regenerationFailures.push(index) });
      return null;
    }
    const value = useChatPersistence();
    persistence[index] = value;
    if (streaming || mockStreaming) {
      const stream =
        mockStreaming ??
        useChatStreaming({
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
      useInterruptedInteractions(
        value,
        mockStreaming
          ? senders[index]
          : async (text) => {
              sent.push([index, text]);
              return true;
            }
      );
    return null;
  }
  root = createRoot(container);
  const render = () =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        ...Array.from({ length: instances }, (_, index) =>
          React.createElement(Harness, { key: index, index })
        )
      )
    );
  await React.act(async () => render());
  const act = (fn) => React.act(async () => fn());
  return {
    db,
    act,
    current: (index = 0) => (agent ? chats[index] : persistence[index]),
    regenerationFailures,
    rerender: () => act(render),
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

for (const scenario of ["single", "together", "reverse", "obsolete session", "removed parent"]) {
  test(`restored connections preserve cumulative outcomes: ${scenario}`, async (t) => {
    const streams = [];
    const streamEnd = Promise.withResolvers();
    const targets = scenario === "single" ? ["slack"] : ["slack", "linear"];
    const connects = Object.fromEntries(targets.map((target) => [target, Promise.withResolvers()]));
    const saves = targets.map(() => Promise.withResolvers());
    t.after(() => {
      streamEnd.resolve();
      saves.forEach((save) => save.resolve());
    });
    const h = await mountPersistence(t, {
      restore: true,
      mockStreaming: {
        sendToAI: async (text, messages) => {
          streams.push(structuredClone({ text, messages }));
          await streamEnd.promise;
        },
      },
    });
    const connected = new Set();
    h.db.api.connectorConnect = async (target) => {
      await connects[target].promise;
      connected.add(target);
      return { status: "connected" };
    };
    h.db.api.connectorStatus = async () =>
      targets.map((id) => ({
        id,
        connected: connected.has(id),
        needsReconnect: false,
      }));
    const statuses = await h.vite.ssrLoadModule("/stores/connectorStatusStore.ts");
    statuses.useConnectorStatusStore.setState({ statuses: {}, loaded: false });
    const { id } = await h.db.api.createAgentConversation("Restored connections");
    const saved = await h.db.api.addAgentMessage(id, "assistant", "", {
      turn: { startedAt: 1, finishedAt: 2, status: "interrupted" },
      toolCalls: targets.map((target) => ({
        id: target,
        name: "request_connection",
        arguments: JSON.stringify({ target }),
        status: "stopped",
        interaction: { payload: { kind: "connection", target }, state: "interrupted" },
      })),
    });
    await h.act(() => h.current().loadConversation(id));
    const update = h.db.api.updateAgentMessage;
    let saving = 0;
    h.db.api.updateAgentMessage = async (...args) => {
      await saves[saving++].promise;
      return update(...args);
    };
    const entries = Object.values(h.store.useAgentInteractionStore.getState().entries);
    assert.equal(entries.length, targets.length, "distinct targets restore as separate cards");
    const order = scenario === "reverse" ? [...entries].reverse() : entries;
    const running = order.map((entry) => h.store.connectInteraction(entry.key));
    await h.act(async () => {
      order.forEach((entry) => connects[entry.payload.target].resolve());
      await Promise.all(running);
    });
    assert.equal(streams.length, 0, "a continuation waits for its answer save");
    if (scenario === "obsolete session") await h.act(() => h.current().handleNewChat());
    if (scenario === "removed parent") await h.act(() => h.current().setMessages([]));
    const earlySends = [];
    for (const [index, save] of saves.entries()) {
      await h.act(() => save.resolve());
      if (index < saves.length - 1) earlySends.push(streams.length);
    }
    await h.act(() => streamEnd.resolve());
    const answers = (calls) =>
      calls
        .filter((call) => call.interaction.result?.status === "connected")
        .map((call) => call.id)
        .sort();
    if (scenario === "obsolete session" || scenario === "removed parent") {
      assert.deepEqual(earlySends, [0]);
      assert.deepEqual(streams, []);
      assert.deepEqual(h.current().messages, []);
    } else {
      const shown = h.current().messages.find((message) => message.dbId === saved.id);
      assert.deepEqual(
        {
          saved: answers(JSON.parse(saved.metadata).toolCalls),
          shown: answers(shown.toolCalls),
          context: answers(
            streams[0]?.messages.find((message) => message.dbId === saved.id).toolCalls ?? []
          ),
          earlySends,
          sends: streams.length,
        },
        {
          saved: [...targets].sort(),
          shown: [...targets].sort(),
          context: [...targets].sort(),
          earlySends: targets.slice(1).map(() => 0),
          sends: 1,
        },
        "all saved/UI/model outcomes survive; one continuation follows every answer save"
      );
      for (const target of targets) assert.match(streams[0].text.toLowerCase(), new RegExp(target));
    }
  });
}

test("a missing parent preflight preserves the current session, messages and owner", async (t) => {
  const h = await mountPersistence(t);
  await h.act(() => h.current().createConversation("Current fork"));
  const id = h.current().conversationId;
  await h.act(() => h.current().claimConversation(id));
  await h.act(() => h.current().setMessages([message("u1", "user", "Keep working")]));
  const version = h.current().getSessionVersion();
  let stopped = false;
  let result;
  await h.act(async () => {
    result = await h.current().loadConversation(999, () => {
      stopped = true;
    });
  });
  assert.equal(result, null);
  assert.equal(stopped, false);
  assert.equal(h.current().conversationId, id);
  assert.equal(h.current().messages[0].content, "Keep working");
  assert.equal(h.current().getSessionVersion(), version);
  assert.equal((await h.db.api.claimAgentConversation(id, "peer")).owned, false);
});

for (const phase of ["preflight", "release", "claim"]) {
  for (const firstFinished of ["earlier", "later"]) {
    test(`the last selected chat wins with ${phase} pending and ${firstFinished} finishing first`, async (t) => {
      const h = await mountPersistence(t);
      const original = await h.db.api.createAgentConversation("Original");
      const earlier = await h.db.api.createAgentConversation("Earlier selection");
      const later = await h.db.api.createAgentConversation("Later selection");
      for (const conversation of [original, earlier, later]) {
        await h.db.api.addAgentMessage(conversation.id, "user", conversation.title);
      }
      await h.act(() => h.current().loadConversation(original.id));
      if (phase === "release") await h.act(() => h.current().claimConversation(original.id));

      const get = h.db.api.getAgentConversation;
      const claim = h.db.api.claimAgentConversation;
      const release = h.db.api.releaseAgentConversation;
      const finish = new Map();
      h.db.api.getAgentConversation = (id) =>
        id === later.id || (phase === "preflight" && id === earlier.id)
          ? new Promise((resolve) => finish.set(id, () => resolve(get(id))))
          : get(id);
      if (phase === "release") {
        h.db.api.releaseAgentConversation = (id, owner) =>
          id === original.id
            ? new Promise((resolve) => finish.set(earlier.id, () => resolve(release(id, owner))))
            : release(id, owner);
      } else if (phase === "claim") {
        h.db.api.claimAgentConversation = (id, owner) =>
          id === earlier.id
            ? new Promise((resolve) => finish.set(id, () => resolve(claim(id, owner))))
            : claim(id, owner);
      }
      const stopped = [];
      let first, second;
      await h.act(() => {
        first = h.current().loadConversation(earlier.id, () => stopped.push(earlier.id));
      });
      await h.act(() => {
        second = h.current().loadConversation(later.id, () => stopped.push(later.id));
      });
      assert.ok(finish.has(earlier.id), "the earlier switch reached the held operation");
      assert.ok(finish.has(later.id), "the later selection is waiting on its preflight");

      const order = firstFinished === "earlier" ? [earlier.id, later.id] : [later.id, earlier.id];
      await h.act(() => finish.get(order[0])());
      if (firstFinished === "earlier") {
        assert.equal(h.current().conversationId, original.id, "a stale selection never opens");
      }
      await h.act(() => finish.get(order[1])());
      let results;
      await h.act(async () => {
        results = await Promise.all([first, second]);
      });
      assert.deepEqual(results, [false, true]);
      assert.equal(h.current().conversationId, later.id);
      assert.deepEqual(
        h.current().messages.map((message) => message.content),
        [later.title]
      );
      if (phase === "preflight") assert.deepEqual(stopped, [later.id]);
      if (phase === "claim") {
        assert.equal((await claim(earlier.id, "peer")).owned, true, "the stale claim was released");
      }
      await h.act(() => h.current().saveUserMessage("Follow up"));
      assert.equal(h.db.calls.add.at(-1).conversation_id, later.id);
      assert.equal(h.db.rows.filter((row) => row.conversation_id === earlier.id).length, 1);
    });
  }
}

for (const leave of ["new chat", "account", "unmount"]) {
  test(`a parent preflight that resolves after ${leave} cannot stop or replace it`, async (t) => {
    const h = await mountPersistence(t);
    let finish;
    h.db.api.getAgentConversation = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    let stopped = false;
    let opening;
    await h.act(() => {
      opening = h.current().loadConversation(9, () => {
        stopped = true;
      });
    });
    if (leave === "unmount") await h.unmount();
    else
      await h.act(() => {
        if (leave === "account") h.db.emitScope({ accountId: "account-b", authGeneration: 2 });
        else h.current().handleNewChat();
        h.current().setMessages([message("new", "user", "Replacement")]);
      });
    let result;
    await h.act(async () => {
      finish({ id: 9, title: "Old parent", messages: [] });
      result = await opening;
    });
    assert.equal(result, false);
    assert.equal(stopped, false);
    if (leave !== "unmount") {
      assert.equal(h.current().conversationId, null);
      assert.equal(h.current().messages[0].content, "Replacement");
    }
  });
}

for (const later of ["selection", "fork"]) {
  for (const firstFinished of ["fork", "selection"]) {
    test(`a later ${later} wins over pending navigation when ${firstFinished} finishes first`, async (t) => {
      const h = await mountPersistence(t);
      const original = await h.db.api.createAgentConversation("Original");
      const selected = await h.db.api.createAgentConversation("Selected chat");
      await h.db.api.addAgentMessage(original.id, "assistant", "Reply to fork");
      await h.act(() => h.current().loadConversation(original.id));
      const through = h.current().messages[0];
      const fork = h.db.api.forkAgentConversation;
      const get = h.db.api.getAgentConversation;
      const finishFork = Promise.withResolvers();
      const finishSelection = Promise.withResolvers();
      h.db.api.forkAgentConversation = async (...args) => {
        await finishFork.promise;
        return fork(...args);
      };
      h.db.api.getAgentConversation = async (id) => {
        if (id === selected.id) await finishSelection.promise;
        return get(id);
      };
      let forking, selecting;
      const startFork = () => {
        forking = h.current().forkConversation(through);
      };
      const startSelection = () => {
        selecting = h.current().loadConversation(selected.id, () => {});
      };
      await h.act(later === "selection" ? startFork : startSelection);
      await h.act(later === "selection" ? startSelection : startFork);
      const finishes = { fork: finishFork, selection: finishSelection };
      await h.act(() => finishes[firstFinished].resolve());
      await h.act(() => finishes[firstFinished === "fork" ? "selection" : "fork"].resolve());
      const forkId = await forking;
      const openedSelection = await selecting;
      if (later === "selection") {
        assert.equal(h.current().conversationId, selected.id);
        assert.equal(forkId, false);
        assert.equal(openedSelection, true);
      } else {
        assert.equal(typeof forkId, "number");
        assert.equal(h.current().conversationId, forkId);
        assert.equal(openedSelection, false);
      }
    });
  }
}

for (const failure of ["owned elsewhere", "claim rejected"]) {
  test(`regeneration can retry after ${failure}`, async (t) => {
    const h = await mountPersistence(t, { streaming: true, agent: true });
    const conversation = await h.db.api.createAgentConversation("Shared");
    await h.db.api.addAgentMessage(conversation.id, "user", "Hello");
    await h.db.api.addAgentMessage(conversation.id, "assistant", "Original reply");
    await h.act(() => h.current().switchChat(conversation.id));
    const claim = h.db.api.claimAgentConversation;
    if (failure === "owned elsewhere") await claim(conversation.id, "peer");
    else
      h.db.api.claimAgentConversation = async () => {
        throw new Error("IPC unavailable");
      };
    await h.act(() => h.current().regenerate(h.current().messages.at(-1)));
    h.db.api.claimAgentConversation = claim;
    await h.act(() => h.db.api.releaseAgentConversation(conversation.id, "peer"));
    h.service.processTextStreamingAI = async function* () {
      yield { type: "content", text: "Regenerated reply" };
    };
    await h.act(() => h.current().regenerate(h.current().messages.at(-1)));
    assert.equal(h.current().messages.at(-1).content, "Regenerated reply");
    assert.equal(h.db.rows.at(-1).content, "Regenerated reply");
    assert.equal(h.db.rows.length, 2, "retry replaces the saved reply");
    assert.deepEqual(h.regenerationFailures, [0]);
  });
}

test("a pending regeneration excludes duplicate clicks across renders and stale completions", async (t) => {
  const h = await mountPersistence(t, { streaming: true, agent: true });
  const conversations = await Promise.all(
    ["First", "Second"].map((title) => h.db.api.createAgentConversation(title))
  );
  for (const conversation of conversations) {
    await h.db.api.addAgentMessage(conversation.id, "user", conversation.title);
    await h.db.api.addAgentMessage(conversation.id, "assistant", `${conversation.title} reply`);
  }
  await h.act(() => h.current().switchChat(conversations[0].id));
  const claim = h.db.api.claimAgentConversation;
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let attempts = 0;
  let firstRegeneration, secondRegeneration;
  t.after(() => {
    first.resolve();
    second.resolve();
  });
  h.db.api.claimAgentConversation = async (...args) => {
    attempts++;
    await (attempts === 1 ? first.promise : second.promise);
    return claim(...args);
  };
  await h.act(() => {
    firstRegeneration = h.current().regenerate(h.current().messages.at(-1));
  });
  await h.rerender();
  await h.act(() => h.current().regenerate(h.current().messages.at(-1)));
  assert.equal(attempts, 1, "a render does not release a pending regeneration");
  h.db.api.claimAgentConversation = claim;
  await h.act(() => h.current().switchChat(conversations[1].id));
  h.db.api.claimAgentConversation = async (...args) => {
    attempts++;
    await second.promise;
    return claim(...args);
  };
  await h.act(() => {
    secondRegeneration = h.current().regenerate(h.current().messages.at(-1));
  });
  assert.equal(attempts, 2, "another conversation has its own regeneration");
  await h.act(async () => {
    first.reject(new Error("Obsolete claim failed"));
    await firstRegeneration;
  });
  await h.act(() => h.current().regenerate(h.current().messages.at(-1)));
  assert.equal(attempts, 2, "the old completion cannot release the newer request");
  assert.deepEqual(
    h.regenerationFailures,
    [],
    "an obsolete failure never interrupts the current chat"
  );
  h.service.processTextStreamingAI = async function* () {
    yield { type: "content", text: "Second regenerated" };
  };
  await h.act(async () => {
    second.resolve();
    await secondRegeneration;
  });
  assert.equal(h.current().messages.at(-1).content, "Second regenerated");
  assert.equal(
    h.db.rows.find((row) => row.conversation_id === conversations[0].id && row.role === "assistant")
      .content,
    "First reply"
  );
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

test("a missing saved reply is never reinserted by a later checkpoint", async (t) => {
  const { db, act, current } = await mountPersistence(t);
  await act(() => current().createConversation("Plan"));
  await act(() => current().setMessages([message("a1", "assistant", "")]));
  await act(() => current().saveAssistantMessage("a1", "Waiting.", undefined, {}));
  db.rows.splice(0);
  await act(() => current().saveAssistantMessage("a1", "Done.", undefined, {}));

  assert.deepEqual(
    db.calls.add.map((call) => call.content),
    ["Waiting."]
  );
  assert.equal(current().messages[0].dbId, 1);
});

test("rejected and unsuccessful updates preserve the exact known saved row", async (t) => {
  for (const result of ["reject", null, false])
    await t.test(String(result), async (t) => {
      const h = await mountPersistence(t);
      await h.act(() => h.current().createConversation("Plan"));
      await h.act(() => h.current().setMessages([message("reply", "assistant", "")]));
      await h.act(() => h.current().saveAssistantMessage("reply", "Waiting."));
      const update = h.db.api.updateAgentMessage;
      const attempted = [];
      h.db.api.updateAgentMessage = async (id) => {
        attempted.push(id);
        if (result === "reject") throw new Error("disk failure");
        return result;
      };
      await assert.doesNotReject(async () =>
        h.act(() => h.current().saveAssistantMessage("reply", "Checkpoint"))
      );
      h.db.api.updateAgentMessage = update;
      await h.act(() => h.current().saveAssistantMessage("reply", "Finished"));
      assert.deepEqual(attempted, [1]);
      assert.equal(h.db.calls.add.length, 1);
      assert.equal(h.db.calls.update.at(-1).id, 1);
      assert.equal(h.db.rows[0].content, "Finished");
    });
});

test("an idle peer's next send uses reclaimed messages and completed-action history", async (t) => {
  const h = await mountPersistence(t, { streaming: true });
  const conversation = await h.db.api.createAgentConversation("Shared");
  await h.db.api.addAgentMessage(conversation.id, "user", "Original task");
  await h.db.api.addAgentMessage(conversation.id, "assistant", "Original reply");
  await h.act(() => h.current().loadConversation(conversation.id));
  await h.db.api.addAgentMessage(conversation.id, "user", "Send it to Gabe");
  await h.db.api.addAgentMessage(conversation.id, "assistant", "Sent to Gabe", {
    toolCalls: [
      {
        id: "sent",
        name: "slack_send_message",
        arguments: "{}",
        status: "completed",
        actionKey: "completed-peer-send",
        metadata: { status: "sent", destination: "Gabe" },
      },
    ],
  });
  let history;
  let backed;
  t.mock.method(h.service, "processTextStreamingAI", (messages, _model, _provider, config) =>
    (async function* () {
      history = messages;
      backed = !config.isUnbackedClaim("I already sent it to Gabe.");
      yield { type: "content", text: "Current reply" };
    })()
  );
  await h.act(() => h.send("What happened?"));
  assert.ok(history.some((row) => row.content === "Send it to Gabe"));
  assert.equal(backed, true);
  assert.equal(h.current().messages[3].toolCalls[0].actionKey, "completed-peer-send");
  assert.equal(h.current().messages.filter((row) => row.content === "What happened?").length, 1);
});

test("a stale regenerate refreshes history and refuses to replace an older reply", async (t) => {
  const h = await mountPersistence(t, { streaming: true });
  const conversation = await h.db.api.createAgentConversation("Shared");
  await h.db.api.addAgentMessage(conversation.id, "user", "First request");
  await h.db.api.addAgentMessage(conversation.id, "assistant", "First reply");
  await h.act(() => h.current().loadConversation(conversation.id));
  const stale = h.current().messages;
  await h.db.api.addAgentMessage(conversation.id, "user", "Peer request");
  await h.db.api.addAgentMessage(conversation.id, "assistant", "Peer reply");
  let runs = 0,
    refused = 0;
  t.mock.method(h.service, "processTextStreamingAI", () =>
    (async function* () {
      runs++;
      yield { type: "content", text: "Wrong replacement" };
    })()
  );
  await h.act(() =>
    h.stream().sendToAI("First request", stale.slice(0, -1), {
      conversationId: conversation.id,
      replaceMessage: stale.at(-1),
      onReplaceFailed: () => refused++,
    })
  );
  assert.equal(runs, 0);
  assert.equal(refused, 1);
  assert.equal(h.current().messages.at(-1).content, "Peer reply");
});

test("claiming a conversation already owned locally keeps its unsaved turn state", async (t) => {
  const h = await mountPersistence(t);
  const conversation = await h.db.api.createAgentConversation("Owned");
  await h.db.api.addAgentMessage(conversation.id, "user", "Saved");
  await h.act(() => h.current().loadConversation(conversation.id));
  await h.act(() => h.current().claimConversation(conversation.id));
  await h.act(() =>
    h.current().setMessages((previous) => [...previous, message("live", "assistant", "Streaming")])
  );
  await h.act(() => h.current().claimConversation(conversation.id));
  assert.equal(h.current().messages.at(-1).content, "Streaming");
});

test("reclaimed action keys reach the next turn's approval guard", async (t) => {
  const h = await mountPersistence(t, { streaming: true });
  const conversation = await h.db.api.createAgentConversation("Shared action");
  await h.act(() => h.current().loadConversation(conversation.id));
  const { connectorActionKey } = await h.vite.ssrLoadModule(
    "/services/tools/connectors/actionKey.ts"
  );
  const args = { destination: "#eng", text: "Ready" };
  await h.db.api.addAgentMessage(conversation.id, "assistant", "Sent", {
    toolCalls: [
      {
        id: "peer",
        name: "slack_send_message",
        arguments: JSON.stringify(args),
        status: "completed",
        actionKey: connectorActionKey("slack", "send_message", args),
        metadata: { status: "sent" },
      },
    ],
  });
  const { useConnectorStatusStore } = await h.vite.ssrLoadModule("/stores/connectorStatusStore.ts");
  useConnectorStatusStore.setState({
    loaded: true,
    statuses: { slack: { connected: true, configured: true, needsReconnect: false } },
  });
  h.db.api.connectorPrepare = async () => ({
    status: "ready",
    actionId: "new",
    preview: {
      verbKey: "slackPost",
      destinationLabel: "#eng",
      accountLabel: "Fixture",
      body: "Ready",
    },
  });
  const approvals = await h.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  t.mock.method(
    h.service,
    "processTextStreamingAI",
    (_messages, _model, _provider, _config, tools) =>
      (async function* () {
        yield {
          type: "tool_calls",
          calls: [{ id: "again", name: "slack_send_message", arguments: JSON.stringify(args) }],
        };
        await tools.slack_send_message.execute(args, { toolCallId: "again", messages: [] });
      })()
  );
  let sending;
  await h.act(() => {
    sending = h.send("Send again");
  });
  const entry = Object.values(approvals.useConnectorApprovalStore.getState().entries)[0];
  assert.ok(entry?.preview.notes?.some((note) => note.key === "connectors.approval.sentEarlier"));
  await h.act(() => approvals.cancelApproval(entry.key));
  await h.act(() => sending);
});

test("a restored connect-before-send call is authoritative not_sent in saved and replayed history", async (t) => {
  const h = await mountPersistence(t, { restore: true });
  const conversation = await h.db.api.createAgentConversation("Connect first");
  await h.db.api.addAgentMessage(conversation.id, "assistant", "", {
    turn: { status: "waiting", startedAt: 1 },
    toolCalls: [
      {
        id: "email",
        name: "email_draft",
        arguments: "{}",
        status: "executing",
        interaction: { state: "pending", payload: { kind: "connection", target: "gmail" } },
      },
    ],
  });
  await h.act(() => h.current().loadConversation(conversation.id));
  const entry = Object.values(h.store.useAgentInteractionStore.getState().entries)[0];
  await h.act(() => h.store.cancelInteraction(entry.key));
  const calls = JSON.parse(h.db.rows[0].metadata).toolCalls;
  assert.equal(calls[0].metadata?.status, "not_sent");
  const { toolTrace } = await h.vite.ssrLoadModule("/components/chat/historyMessages.ts");
  assert.match(toolTrace(calls), /not sent/);
  assert.doesNotMatch(toolTrace(calls), /outcome not recorded/);
});

test("failed fork creation keeps the parent session and runs stop-before-open only on success", async (t) => {
  for (const failure of [null, "reject"])
    await t.test(String(failure), async (t) => {
      const h = await mountPersistence(t);
      const conversation = await h.db.api.createAgentConversation("Parent");
      await h.db.api.addAgentMessage(conversation.id, "assistant", "Reply");
      await h.act(() => h.current().loadConversation(conversation.id));
      const version = h.current().getSessionVersion();
      const fork = h.db.api.forkAgentConversation;
      h.db.api.forkAgentConversation = async () => {
        if (failure === "reject") throw new Error("disk failure");
        return null;
      };
      let stopped = 0;
      let result;
      await assert.doesNotReject(async () =>
        h.act(async () => {
          result = await h
            .current()
            .forkConversation(h.current().messages[0], undefined, () => stopped++);
        })
      );
      assert.equal(result, null);
      assert.equal(stopped, 0);
      assert.equal(h.current().getSessionVersion(), version);
      assert.equal(h.current().conversationId, conversation.id);
      h.db.api.forkAgentConversation = fork;
      await h.act(() =>
        h.current().forkConversation(h.current().messages[0], undefined, () => stopped++)
      );
      assert.equal(stopped, 1);
      assert.notEqual(h.current().conversationId, conversation.id);
    });
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
  for (const leave of ["new chat", "account", "conversation"])
    await t.test(leave, async (t) => {
      const { db, act, current } = await mountPersistence(t);
      const conversation = await db.api.createAgentConversation("Launch plan");
      const replacement = await db.api.createAgentConversation("Replacement");
      await db.api.addAgentMessage(conversation.id, "assistant", "Draft one.");
      await act(() => current().loadConversation(conversation.id));
      let finishFork;
      const fork = db.api.forkAgentConversation;
      db.api.forkAgentConversation = (...args) =>
        new Promise((resolve) => (finishFork = () => resolve(fork(...args))));

      let result,
        stopped = 0;
      await act(async () => {
        const forking = current().forkConversation(
          current().messages[0],
          undefined,
          () => stopped++
        );
        if (leave === "conversation") await current().loadConversation(replacement.id);
        else if (leave === "account") db.emitScope({ accountId: "account-b", authGeneration: 1 });
        else current().handleNewChat();
        finishFork();
        result = await forking;
      });
      assert.equal(result, false);
      assert.equal(stopped, 0, "the replacement session is never stopped");
      assert.equal(current().conversationId, leave === "conversation" ? replacement.id : null);
    });
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
