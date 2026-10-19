const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// useChatPersistence mounted for real against an in-memory stand-in for the
// conversation IPC: ids, in-place updates, waiting replies and forks.
function fakeDb() {
  let nextId = 1;
  const rows = [];
  const conversations = new Map();
  const calls = { add: [], update: [], fork: [] };
  const get = (id) => {
    const conversation = conversations.get(id);
    if (!conversation) return null;
    const parent = conversations.get(conversation.parent_conversation_id);
    return {
      ...conversation,
      parent_title: parent?.title ?? null,
      fork_message_count: rows.filter(
        (row) =>
          row.conversation_id === conversation.parent_conversation_id &&
          row.id <= conversation.fork_message_id
      ).length,
      messages: rows.filter((row) => row.conversation_id === id),
    };
  };
  const api = {
    createAgentConversation: async (title) => {
      const conversation = { id: 100 + conversations.size, title, parent_conversation_id: null };
      conversations.set(conversation.id, conversation);
      return conversation;
    },
    getAgentConversation: async (id) => get(id),
    addAgentMessage: async (conversation_id, role, content, metadata) => {
      calls.add.push({ conversation_id, role, content, metadata });
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
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      Object.assign(row, { content, metadata: metadata ? JSON.stringify(metadata) : null });
      return row;
    },
    forkAgentConversation: async (conversationId, throughId, context) => {
      calls.fork.push({ conversationId, throughId, context });
      const source = conversations.get(conversationId);
      const fork = {
        id: 100 + conversations.size,
        title: source.title,
        parent_conversation_id: conversationId,
        fork_message_id: throughId,
        fork_context: context,
      };
      conversations.set(fork.id, fork);
      for (const row of rows.filter(
        (r) => r.conversation_id === conversationId && r.id <= throughId
      )) {
        rows.push({ ...row, id: nextId++, conversation_id: fork.id });
      }
      return get(fork.id);
    },
  };
  return { api, rows, calls, conversations };
}

async function mountPersistence(t) {
  const db = fakeDb();
  let root;
  // Node runs after hooks in registration order: unmount while the DOM exists.
  t.after(() => root && React.act(async () => root.unmount()));
  installBrowserGlobals(t, { window: { electronAPI: db.api } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-chat-persistence-test-" });
  const { useChatPersistence } = await vite.ssrLoadModule("/components/chat/useChatPersistence.ts");
  const { createRoot } = require("react-dom/client");
  let persistence;
  function Harness() {
    persistence = useChatPersistence();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const act = (fn) => React.act(async () => fn());
  return { db, act, current: () => persistence };
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
