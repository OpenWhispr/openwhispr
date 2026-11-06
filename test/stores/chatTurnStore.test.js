const test = require("node:test");
const assert = require("node:assert/strict");
const { setupChatTurns, deferred, until, flush } = require("../lib/chatTurnHarness");

test("New chat is reserved before creation and navigation does not move its answer", async (t) => {
  const creation = deferred();
  const { store, state, send, streams, writes } = await setupChatTurns(t, {
    createAgentConversation: () => creation.promise,
  });
  store.setChatDraft({ kind: "new-chat" }, "typed, not sent");
  assert.equal(send(), true);
  assert.equal(state().selection.kind, "submission");
  assert.equal(Object.values(state().entries)[0].agentState, "thinking");
  assert.equal(state().newChatDraft, "typed, not sent", "only the composer clears what it sends");
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
  // The stopped turn keeps its reply, saved when it started; what came after Stop isn't in it.
  assert.deepEqual(
    writes
      .filter((write) => write.role === "assistant")
      .map((write) => write.content)
      .sort(),
    ["", "new one", "two answer"]
  );
});

test("a turn gives its conversation back after the chat is dropped for deletion", async (t) => {
  const owners = new Map();
  const { store, send, streams } = await setupChatTurns(t, {
    claimAgentConversation: async (id, owner) => {
      const owned = !owners.has(id) || owners.get(id) === owner;
      if (owned) owners.set(id, owner);
      return { owned, conversation: { id, title: `Chat ${id}`, messages: [] } };
    },
    releaseAgentConversation: async (id, owner) => {
      if (owners.get(id) === owner) owners.delete(id);
    },
  });
  store.selectChat({ kind: "conversation", conversationId: 4 });
  send();
  await until(() => streams.length === 1);
  assert.equal(owners.has(4), true);
  // ChatView drops a chat before deleting it, and a delete that fails keeps the row.
  store.dropChatConversation(4);
  streams[0].resolve("late");
  await until(() => !owners.has(4));
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

// A stream that shows text and a tool step, then holds until released, ignoring the abort like a
// tool that has already gone out.
function holdAfter(fixture, chunks) {
  const release = deferred();
  fixture.reasoning.processTextStreamingAI.mock.mockImplementation(async function* () {
    for (const chunk of chunks.before) yield chunk;
    await release.promise;
    for (const chunk of chunks.after ?? []) yield chunk;
  });
  return release;
}
const TEXT = { type: "content", text: "partial answer" };
const STEP = { id: "c1", name: "email_draft", arguments: "{}" };
const assistantOf = (fixture, id) =>
  fixture.state().entries[`conversation:${id}`].messages.find((m) => m.role === "assistant");

test("Stop keeps the partial answer and its finished tool step, saved as a stopped reply", async (t) => {
  const fixture = await setupChatTurns(t);
  const release = holdAfter(fixture, {
    before: [
      TEXT,
      { type: "tool_calls", calls: [STEP] },
      {
        type: "tool_result",
        callId: "c1",
        displayText: "Draft opened",
        metadata: { status: "sent" },
      },
    ],
  });
  const { store, state, send, writes } = fixture;
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send();
  await until(() => assistantOf(fixture, 2)?.toolCalls?.[0]?.status === "completed");
  store.cancelChatTurn({ kind: "conversation", conversationId: 2 });
  const entry = state().entries["conversation:2"];
  assert.equal(entry.running, false);
  const kept = assistantOf(fixture, 2);
  assert.equal(kept.content, "partial answer");
  assert.equal(kept.isStreaming, false);
  assert.equal(kept.toolCalls[0].status, "completed");
  release.resolve();
  await until(() => state().entries["conversation:2"].settling === false);
  assert.deepEqual(
    writes.map((write) => write.role),
    ["user", "assistant"]
  );
  assert.equal(writes[1].content, "partial answer");
  assert.equal(writes[1].metadata.turn.status, "stopped");
  assert.equal(writes[1].metadata.toolCalls[0].status, "completed");
});

test("Stop before any text keeps the stopped reply, as it is saved", async (t) => {
  const fixture = await setupChatTurns(t);
  const { store, state, send, streams, writes } = fixture;
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send();
  await until(() => streams.length === 1);
  store.cancelChatTurn({ kind: "conversation", conversationId: 2 });
  streams[0].resolve("too late");
  await until(() => state().entries["conversation:2"].settling === false);
  const [, reply] = state().entries["conversation:2"].messages;
  assert.equal(reply.content, "");
  assert.equal(reply.turn.status, "stopped");
  // The reply's row was saved when the turn started; Stop completes it, never adds one.
  assert.deepEqual(
    writes.map((write) => [write.role, write.content, write.metadata?.turn?.status]),
    [
      ["user", "Question", undefined],
      ["assistant", "", "stopped"],
    ]
  );
});

test("Stop before the first text is shown keeps it, as the stopped reply saves it", async (t) => {
  const fixture = await setupChatTurns(t);
  const received = deferred();
  const release = deferred();
  fixture.reasoning.processTextStreamingAI.mock.mockImplementation(async function* () {
    yield TEXT;
    received.resolve();
    await release.promise;
  });
  const { store, state, send, writes } = fixture;
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send();
  await received.promise;
  store.cancelChatTurn({ kind: "conversation", conversationId: 2 });
  release.resolve();
  await until(() => state().entries["conversation:2"].settling === false);
  assert.equal(writes[1].content, "partial answer");
  assert.equal(assistantOf(fixture, 2)?.content, "partial answer");
});

test("a stopped turn settles before the view takes it, its unfinished tool still on the message", async (t) => {
  const fixture = await setupChatTurns(t);
  const release = holdAfter(fixture, {
    before: [TEXT, { type: "tool_calls", calls: [STEP] }],
  });
  const { store, state, send, writes, vite } = fixture;
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send();
  await until(() => assistantOf(fixture, 2)?.toolCalls?.[0]?.status === "executing");
  store.cancelChatTurn({ kind: "conversation", conversationId: 2 });
  assert.equal(store.takeCompletedChatTurn(2), null, "the stopped turn is still settling");
  release.resolve();
  await until(() => state().entries["conversation:2"].settling === false);
  // Its side effect may still land, so the next turn's history says the outcome isn't recorded.
  const { toolTrace } = await vite.ssrLoadModule("/components/chat/historyMessages.ts");
  assert.equal(assistantOf(fixture, 2).toolCalls[0].status, "stopped");
  assert.equal(
    toolTrace(assistantOf(fixture, 2).toolCalls),
    "[Tools used: email_draft (outcome not recorded)]"
  );
  assert.equal(assistantOf(fixture, 2).isStreaming, false);
  assert.equal(store.takeCompletedChatTurn(2).running, false);
  assert.deepEqual(
    writes.map((write) => write.role),
    ["user", "assistant"]
  );
});

test("a send right after Stop isn't overwritten by the stopped turn's late result", async (t) => {
  const fixture = await setupChatTurns(t);
  const release = holdAfter(fixture, {
    before: [TEXT, { type: "tool_calls", calls: [STEP] }],
    after: [{ type: "tool_result", callId: "c1", displayText: "late" }],
  });
  const { store, state, send } = fixture;
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send("first");
  await until(() => assistantOf(fixture, 2)?.toolCalls?.[0]?.status === "executing");
  store.cancelChatTurn({ kind: "conversation", conversationId: 2 });
  assert.equal(send("second"), true);
  const submissionId = state().entries["conversation:2"].submissionId;
  release.resolve();
  await flush();
  await flush();
  const entry = state().entries["conversation:2"];
  assert.equal(entry.submissionId, submissionId);
  assert.equal(entry.messages.find((m) => m.role === "assistant").toolCalls[0].status, "executing");
});

test("New chat keeps the unsent New chat text when the user comes back to it", async (t) => {
  const { store, state } = await setupChatTurns(t);
  store.setChatDraft({ kind: "new-chat" }, "half a thought");
  store.setChatSkills(
    { kind: "new-chat" },
    {
      attached: { ref: { name: "x" }, displayName: "X" },
      pickOff: false,
      removed: [],
    }
  );
  store.selectChat({ kind: "conversation", conversationId: 2 });
  store.startNewChat();
  assert.equal(state().newChatDraft, "half a thought");
  assert.equal(state().newChatSkills.attached, null, "New chat still starts without a skill");
  store.startNewChat();
  assert.equal(state().newChatDraft, "half a thought");
});

test("Stop while creating returns the question and removes the row it no longer needs", async (t) => {
  const creation = deferred();
  const deleted = [];
  const fixture = await setupChatTurns(t, {
    createAgentConversation: () => creation.promise,
    deleteAgentConversation: async (id) => {
      deleted.push(id);
      return { success: true };
    },
  });
  const { store, state, send, writes } = fixture;
  const skills = {
    attached: { ref: { name: "x" }, displayName: "X" },
    pickOff: false,
    removed: [],
  };
  store.setChatDraft({ kind: "new-chat" }, "the question");
  send("the question", { skills });
  store.setChatDraft({ kind: "new-chat" }, "ignored");
  store.cancelChatTurn(state().selection);
  assert.deepEqual(state().selection, { kind: "new-chat" });
  assert.equal(state().newChatDraft, "ignored\n\nthe question");
  assert.deepEqual(state().newChatSkills, skills);
  const revision = state().listRevision;
  creation.resolve({ id: 31 });
  await until(() => deleted.length === 1);
  assert.deepEqual(deleted, [31]);
  await until(() => state().listRevision > revision);
  assert.deepEqual(writes, []);
  assert.deepEqual(state().entries, {});
});

test("an account reset during creation removes the row without restoring the question", async (t) => {
  const creation = deferred();
  const deleted = [];
  const { store, state, send, writes } = await setupChatTurns(t, {
    createAgentConversation: () => creation.promise,
    deleteAgentConversation: async (id) => {
      deleted.push(id);
      throw new Error("a failed cleanup stays quiet");
    },
  });
  send("private question");
  store.resetForAccountChange();
  creation.resolve({ id: 32 });
  await until(() => deleted.length === 1);
  await flush();
  assert.equal(state().newChatDraft, "");
  assert.deepEqual(writes, []);
});

test("a conversation's unsent text survives a send that didn't come from the composer", async (t) => {
  const { store, state, send, streams } = await setupChatTurns(t);
  store.selectChat({ kind: "conversation", conversationId: 2 });
  store.setChatDraft(state().selection, "typed, not sent");
  send("from a suggestion");
  await until(() => streams.length === 1);
  assert.equal(state().drafts[2], "typed, not sent");
});

test("a refused send returns its text after whatever is already typed", async (t) => {
  const { store, state } = await setupChatTurns(t);
  store.returnChatDraft({ kind: "new-chat" }, "refused");
  assert.equal(state().newChatDraft, "refused");
  store.setChatDraft({ kind: "new-chat" }, "typed");
  store.returnChatDraft({ kind: "new-chat" }, "refused");
  assert.equal(state().newChatDraft, "typed\n\nrefused");
  store.returnChatDraft({ kind: "conversation", conversationId: 2 }, "refused");
  assert.equal(state().drafts[2], "refused");
  store.returnChatDraft({ kind: "conversation", conversationId: 2 }, "again");
  assert.equal(state().drafts[2], "refused\n\nagain");
});

test("main chat offers the connector tools and skills", async (t) => {
  t.after(() => delete globalThis.__turnOptions);
  const { send } = await setupChatTurns(
    t,
    {},
    {
      "/chatTurnEngine": `
      export function createChatTurnEngine(getOptions) {
        return {
          async send() {
            globalThis.__turnOptions = getOptions();
          },
          cancel() {},
        };
      }
    `,
    }
  );
  send();
  await until(() => globalThis.__turnOptions);
  assert.equal(globalThis.__turnOptions.allowConnectors, true);
  assert.equal(globalThis.__turnOptions.skillsEnabled, true);
});
