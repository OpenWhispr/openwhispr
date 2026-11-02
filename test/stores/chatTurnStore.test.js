const test = require("node:test");
const assert = require("node:assert/strict");
const { setupChatTurns, deferred, until, flush } = require("../lib/chatTurnHarness");

test("New chat is reserved before creation and navigation does not move its answer", async (t) => {
  const creation = deferred();
  const { store, state, send, streams, writes } = await setupChatTurns(t, {
    createAgentConversation: () => creation.promise,
  });
  store.setChatDraft({ kind: "new-chat" }, "Question");
  assert.equal(send(), true);
  assert.equal(state().selection.kind, "submission");
  assert.equal(Object.values(state().entries)[0].agentState, "thinking");
  assert.equal(state().newChatDraft, "");
  assert.equal(send(), false);
  store.selectChat({ kind: "conversation", conversationId: 7 });
  creation.resolve({ id: 21 });
  await until(() => streams.length === 1);
  assert.deepEqual(state().selection, { kind: "conversation", conversationId: 7 });
  streams[0].resolve("Saved reply");
  await until(() => !state().entries["conversation:21"].running);
  assert.deepEqual(
    writes.map(({ id, role }) => [id, role]),
    [
      [21, "user"],
      [21, "assistant"],
    ]
  );
});

test("two conversations answer independently and stop cannot release a newer turn", async (t) => {
  const { store, state, send, streams, writes } = await setupChatTurns(t);
  store.selectChat({ kind: "conversation", conversationId: 1 });
  send("one");
  await until(() => streams.length === 1);
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send("two");
  await until(() => streams.length === 2);
  store.cancelChatTurn({ kind: "conversation", conversationId: 1 });
  assert.equal(streams[0].signal.aborted, true);
  assert.equal(streams[1].signal.aborted, false);
  store.selectChat({ kind: "conversation", conversationId: 1 });
  send("replacement");
  await until(() => streams.length === 3);
  streams[0].resolve("discard me");
  await flush();
  assert.equal(state().entries["conversation:1"].running, true);
  streams[2].resolve("new one");
  streams[1].resolve("two answer");
  await until(() => Object.values(state().entries).every((entry) => !entry.running));
  assert.deepEqual(
    writes
      .filter((write) => write.role === "assistant")
      .map((write) => write.content)
      .sort(),
    ["new one", "two answer"]
  );
});

test("failed creations restore each question once after the newer New chat draft", async (t) => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  const { store, state, send } = await setupChatTurns(t, {
    createAgentConversation: () => (calls++ === 0 ? first.promise : second.promise),
  });
  send("first question");
  store.startNewChat();
  send("second question");
  store.startNewChat();
  store.setChatDraft(state().selection, "new draft");
  second.reject(new Error("offline"));
  await until(() => state().newChatDraft.includes("second question"));
  first.reject(new Error("offline"));
  await until(() => Object.keys(state().entries).length === 0);
  assert.equal(state().newChatDraft, "new draft\n\nsecond question\n\nfirst question");
});

test("an assistant write acknowledgment holds ownership until the answer is durable", async (t) => {
  const saved = deferred();
  const { store, state, send, streams } = await setupChatTurns(t, {
    addAgentMessage: async (_id, role) => (role === "assistant" ? saved.promise : { id: 1 }),
  });
  store.selectChat({ kind: "conversation", conversationId: 3 });
  send();
  await until(() => streams.length === 1);
  streams[0].resolve("answer");
  await flush();
  await flush();
  assert.equal(state().entries["conversation:3"].running, true);
  assert.equal(store.takeCompletedChatTurn(3), null);
  saved.resolve({ id: 2 });
  await until(() => !state().entries["conversation:3"].running);
  assert.equal(store.takeCompletedChatTurn(3).messages.at(-1).content, "answer");
  assert.equal(state().entries["conversation:3"], undefined);
});

test("account reset fences delayed creation and already streaming results", async (t) => {
  const creation = deferred();
  const { store, state, send, streams, writes } = await setupChatTurns(t, {
    createAgentConversation: () => creation.promise,
  });
  store.selectChat({ kind: "conversation", conversationId: 1 });
  send();
  await until(() => streams.length === 1);
  store.startNewChat();
  send("pending");
  store.startNewChat();
  store.setChatDraft(state().selection, "private draft");
  const before = writes.length;
  store.resetForAccountChange();
  assert.deepEqual(state().entries, {});
  assert.equal(state().newChatDraft, "");
  assert.deepEqual(state().selection, { kind: "new-chat" });
  creation.resolve({ id: 50 });
  streams[0].resolve("private reply");
  await flush();
  await flush();
  assert.equal(writes.length, before);
  assert.deepEqual(state().entries, {});
});

test("a rejected user write does not start inference and remains a visible failure", async (t) => {
  const { store, state, send, streams } = await setupChatTurns(t, {
    addAgentMessage: async () => {
      throw new Error("disk full");
    },
  });
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send();
  await until(() => !state().entries["conversation:2"].running);
  assert.equal(streams.length, 0);
  assert.equal(state().entries["conversation:2"].messages.length, 2);
});

test("New chat exposes a failed background creation's recovered question", async (t) => {
  const creation = deferred();
  const fixture = await setupChatTurns(t, { createAgentConversation: () => creation.promise });
  fixture.send("recover this question");
  fixture.store.selectChat({ kind: "conversation", conversationId: 7 });
  creation.reject(new Error("database busy"));
  await until(() => fixture.state().newChatError !== null);
  fixture.store.startNewChat();
  assert.equal(fixture.state().newChatDraft, "recover this question");
  assert.ok(fixture.state().newChatError);
});
