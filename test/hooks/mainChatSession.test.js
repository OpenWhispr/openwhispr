const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { installHookDom } = require("../lib/rendererTestHarness");
const { setupChatTurns, deferred, until, flush } = require("../lib/chatTurnHarness");

async function mountSession(t, fixture) {
  const container = installHookDom(t);
  const { useMainChatSession } = await fixture.vite.ssrLoadModule(
    "/components/chat/useMainChatSession.ts"
  );
  const root = createRoot(container);
  let session;
  let renders = 0;
  function Harness() {
    renders += 1;
    session = useMainChatSession();
    return null;
  }
  await React.act(async () => root.render(React.createElement(Harness)));
  let unmounted = false;
  const unmount = async () => {
    if (!unmounted) {
      unmounted = true;
      await React.act(async () => root.unmount());
    }
  };
  fixture.unmounts.push(unmount);
  return { session: () => session, unmount, renders: () => renders };
}

for (const archived of [true, false]) {
  test(`restore validates a cached ${archived ? "archived" : "deleted"} conversation before displaying it`, async (t) => {
    const row = archived ? { id: 2, archived_at: "2026-11-02", messages: [] } : null;
    const fixture = await setupChatTurns(t, { getAgentConversation: async () => row });
    fixture.store.selectChat({ kind: "conversation", conversationId: 2 });
    fixture.send();
    await until(() => fixture.streams.length === 1);
    const mounted = await mountSession(t, fixture);
    assert.equal(mounted.session().selection.kind, "new-chat");
    assert.equal(fixture.streams[0].signal.aborted, !archived);
    assert.equal(Boolean(fixture.state().entries["conversation:2"]), archived);
  });
}

test("opening from Archived works, but an obsolete validation cannot replace a newer selection", async (t) => {
  const slow = deferred();
  const fixture = await setupChatTurns(t, {
    getAgentConversation: async (id) =>
      id === 1 ? slow.promise : { id, archived_at: "date", messages: [] },
  });
  const mounted = await mountSession(t, fixture);
  let first;
  await React.act(async () => {
    first = mounted.session().openConversation(1, "sidebar");
  });
  assert.equal(mounted.session().loading, true);
  await React.act(async () => mounted.session().openConversation(2, "sidebar"));
  assert.deepEqual(mounted.session().selection, { kind: "conversation", conversationId: 2 });
  await React.act(async () => {
    slow.resolve(null);
    await first;
  });
  assert.deepEqual(mounted.session().selection, { kind: "conversation", conversationId: 2 });
  assert.equal(mounted.session().loading, false);
});

test("returning to a pending submission preserves its message and then its completed message IDs", async (t) => {
  const creation = deferred();
  const fixture = await setupChatTurns(t, { createAgentConversation: () => creation.promise });
  fixture.send("original question");
  const pending = await mountSession(t, fixture);
  assert.equal(pending.session().messages[0].content, "original question");
  assert.equal(pending.session().agentState, "thinking");
  await pending.unmount();
  creation.resolve({ id: 8 });
  await until(() => fixture.streams.length === 1);
  fixture.streams[0].resolve("background answer");
  await until(() => !fixture.state().entries["conversation:8"].running);
  const expectedId = fixture.state().entries["conversation:8"].messages.at(-1).id;
  const reopened = await mountSession(t, fixture);
  assert.equal(reopened.session().messages.at(-1).id, expectedId);
  assert.equal(fixture.state().entries["conversation:8"], undefined);
});

test("a reset invalidates held row validation and clears the mounted snapshot", async (t) => {
  const row = deferred();
  const fixture = await setupChatTurns(t, { getAgentConversation: () => row.promise });
  const mounted = await mountSession(t, fixture);
  let opening;
  await React.act(async () => {
    opening = mounted.session().openConversation(2, "sidebar");
  });
  await React.act(async () => fixture.store.resetForAccountChange());
  await React.act(async () => {
    row.resolve({ id: 2, messages: [{ role: "user", content: "private" }] });
    await opening;
  });
  assert.equal(mounted.session().selection.kind, "new-chat");
  assert.deepEqual(mounted.session().messages, []);
});

test("a live reply survives session unmount and resumes with the same assistant ID", async (t) => {
  const fixture = await setupChatTurns(t);
  fixture.store.selectChat({ kind: "conversation", conversationId: 2 });
  const first = await mountSession(t, fixture);
  await React.act(async () => {
    first.session().send("question");
    await until(() => fixture.streams.length === 1);
  });
  const assistantId = first.session().messages.at(-1).id;
  await first.unmount();
  assert.equal(fixture.streams[0].signal.aborted, false);
  const second = await mountSession(t, fixture);
  assert.equal(second.session().messages.at(-1).id, assistantId);
  await React.act(async () => {
    fixture.streams[0].resolve("answer");
    await flush();
    await flush();
  });
  assert.equal(second.session().messages.at(-1).content, "answer");
  assert.equal(second.session().agentState, "idle");
});

test("load failures hide stale messages and reject sends until a successful retry", async (t) => {
  let fail = true;
  const fixture = await setupChatTurns(t, {
    getAgentConversation: async (id) => {
      if (fail) throw new Error("offline");
      return { id, messages: [{ role: "user", content: "history" }] };
    },
  });
  const mounted = await mountSession(t, fixture);
  await React.act(async () => mounted.session().openConversation(1, "sidebar"));
  assert.ok(mounted.session().error);
  assert.deepEqual(mounted.session().messages, []);
  assert.equal(mounted.session().send("do not send"), false);
  fail = false;
  await React.act(async () => {
    mounted.session().retryLoad();
    await flush();
  });
  assert.equal(mounted.session().error, null);
  assert.equal(mounted.session().messages[0].content, "history");
});

test("a held assistant save remains owned through validation and account reset", async (t) => {
  const saving = deferred();
  const writes = [];
  const fixture = await setupChatTurns(t, {
    addAgentMessage: async (id, role, content) => {
      writes.push({ id, role, content });
      if (role === "assistant") await saving.promise;
      return { id: writes.length };
    },
  });
  fixture.store.selectChat({ kind: "conversation", conversationId: 1 });
  fixture.send();
  await until(() => fixture.streams.length === 1);
  fixture.streams[0].resolve("finished answer");
  await until(() => writes.length === 2);
  const mounted = await mountSession(t, fixture);
  assert.equal(fixture.state().entries["conversation:1"].running, true);
  assert.equal(mounted.session().messages.at(-1).content, "finished answer");
  await React.act(async () => fixture.store.resetForAccountChange());
  await React.act(async () => {
    saving.resolve();
    await flush();
  });
  assert.deepEqual(fixture.state().entries, {});
  assert.deepEqual(mounted.session().messages, []);
  assert.equal(writes.length, 2);
});

for (const kind of ["connector", "skill"]) {
  test(`${kind} approval survives two view visits and cancelling an independent embedded turn`, async (t) => {
    const commits = [];
    const fixture = await setupChatTurns(t, {
      connectorStatus: async () => [
        {
          id: "slack",
          connected: true,
          accountLabel: "chad",
          workspaceLabel: "Acme",
          needsReconnect: false,
        },
      ],
      onConnectorStatusChanged: () => () => {},
      connectorPrepare: async () => ({
        status: "ready",
        actionId: "action-a",
        preview: {
          verbKey: "slackPost",
          destinationLabel: "#eng",
          accountLabel: "chad",
          workspaceLabel: "Acme",
          body: "Hi team",
        },
      }),
      connectorCommit: async (id) => {
        commits.push(id);
        return { state: "sent" };
      },
      connectorCancel: async () => ({ cancelled: true }),
      skillsList: async () => ({ skills: [] }),
      skillsCheckProposal: async () => ({ existing: false, name: "weekly-recap", problems: [] }),
      skillsSaveProposal: async () => {
        commits.push("skill-a");
        return { ok: true, name: "weekly-recap", title: "Weekly recap" };
      },
    });
    globalThis.localStorage.setItem("isSubscribed", "true");
    (await fixture.vite.ssrLoadModule("/stores/settingsStore.ts")).useSettingsStore.setState({
      isSignedIn: true,
    });
    const approvals = await fixture.vite.ssrLoadModule(
      kind === "connector" ? "/stores/connectorApprovalStore.ts" : "/stores/skillApprovalStore.ts"
    );
    const approvalStore =
      kind === "connector" ? approvals.useConnectorApprovalStore : approvals.useSkillApprovalStore;
    const call = {
      id: "call-a",
      name: kind === "connector" ? "slack_send_message" : "propose_skill",
    };
    const args =
      kind === "connector"
        ? { destination: "#eng", text: "Hi team" }
        : {
            title: "Weekly recap",
            description: "Recaps my week.",
            instructions: "Summarize the week.",
            files: [],
          };
    fixture.reasoning.processTextStreamingAI.mock.mockImplementation(
      async function* (_messages, _model, _provider, _config, tools, signal) {
        if (Object.keys(approvalStore.getState().entries).length > 0) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return;
        }
        yield { type: "tool_calls", calls: [{ ...call, arguments: JSON.stringify(args) }] };
        const result = await tools[call.name].execute(args, { toolCallId: call.id, messages: [] });
        yield {
          type: "tool_result",
          callId: call.id,
          toolName: call.name,
          metadata: result,
          displayText: "",
        };
        yield { type: "content", text: "Done" };
      }
    );
    fixture.store.selectChat({ kind: "conversation", conversationId: 1 });
    fixture.send(
      "Question",
      kind === "skill"
        ? { options: { attachedSkill: { name: "skill-creator", builtin: true } } }
        : {}
    );
    await until(() => Object.keys(approvalStore.getState().entries).length === 1);
    const approval = Object.values(approvalStore.getState().entries)[0];
    const first = await mountSession(t, fixture);
    assert.equal(first.session().messages.at(-1).id, approval.messageId);
    await first.unmount();
    const { createChatTurnEngine } = await fixture.vite.ssrLoadModule(
      "/components/chat/chatTurnEngine.ts"
    );
    let embeddedState = "idle";
    const embedded = createChatTurnEngine(() => ({ userName: null }), {
      setMessages() {},
      setAgentState(value) {
        embeddedState = value;
      },
      setToolStatus() {},
      setActiveToolName() {},
    });
    const embeddedSend = embedded.send("Other question", []);
    await until(() => embeddedState === "streaming");
    await flush();
    embedded.cancel({ explicit: true });
    await embeddedSend;
    assert.equal(approvalStore.getState().entries[approval.key].state, "pending");
    const second = await mountSession(t, fixture);
    assert.equal(second.session().messages.at(-1).id, approval.messageId);
    await React.act(async () => {
      if (kind === "connector") await approvals.approveAction(approval.key);
      else await approvals.saveSkillApproval(approval.key);
      await flush();
    });
    assert.deepEqual(commits, [kind === "connector" ? "action-a" : "skill-a"]);
    assert.equal(second.session().messages.at(-1).content, "Done");
    assert.equal(fixture.writes.filter((row) => row.role === "assistant").length, 1);
  });
}

test("a row that survives failed deletion can send again without reviving its discarded turn", async (t) => {
  const fixture = await setupChatTurns(t);
  fixture.store.selectChat({ kind: "conversation", conversationId: 2 });
  fixture.send("old question");
  await until(() => fixture.streams.length === 1);
  fixture.store.dropChatConversation(2);
  const mounted = await mountSession(t, fixture);
  await React.act(async () => mounted.session().openConversation(2, "sidebar"));
  await React.act(async () => {
    assert.equal(mounted.session().send("new question"), true);
    await until(() => fixture.streams.length === 2);
  });
  await React.act(async () => {
    fixture.streams[0].resolve("discarded answer");
    await flush();
  });
  assert.equal(
    fixture.writes.some((row) => row.content === "discarded answer"),
    false
  );
  assert.notEqual(mounted.session().agentState, "idle");
});

test("a conversation created from New chat stays on screen while its row validates", async (t) => {
  const creation = deferred();
  const row = deferred();
  const fixture = await setupChatTurns(t, {
    createAgentConversation: () => creation.promise,
    getAgentConversation: () => row.promise,
  });
  const mounted = await mountSession(t, fixture);
  await React.act(async () => mounted.session().send("first question"));
  const messageId = mounted.session().messages[0].id;
  await React.act(async () => {
    creation.resolve({ id: 8 });
    await until(() => fixture.state().selection.kind === "conversation");
    await flush();
  });
  assert.deepEqual(mounted.session().selection, { kind: "conversation", conversationId: 8 });
  assert.equal(mounted.session().loading, false);
  assert.equal(mounted.session().sourceNoteLoading, false);
  assert.equal(mounted.session().messages[0].id, messageId);
  await until(() => fixture.streams.length === 1);
  await React.act(async () => {
    row.resolve({ id: 8, messages: [], note_id: null });
    await flush();
  });
  assert.equal(mounted.session().messages[0].id, messageId);
  assert.equal(mounted.session().error, null);
});

test("a new conversation deleted while it validates still falls back to New chat", async (t) => {
  const row = deferred();
  const fixture = await setupChatTurns(t, { getAgentConversation: () => row.promise });
  const mounted = await mountSession(t, fixture);
  await React.act(async () => mounted.session().send("first question"));
  await until(() => fixture.state().selection.kind === "conversation");
  await until(() => fixture.streams.length === 1);
  await React.act(async () => {
    row.resolve(null);
    await flush();
  });
  assert.deepEqual(mounted.session().selection, { kind: "new-chat" });
  assert.equal(fixture.streams[0].signal.aborted, true);
});

test("clicking the open conversation leaves it alone, unsaved error included", async (t) => {
  let reads = 0;
  const fixture = await setupChatTurns(t, {
    getAgentConversation: async (id) => {
      reads += 1;
      return { id, messages: [], note_id: null };
    },
  });
  const mounted = await mountSession(t, fixture);
  await React.act(async () => mounted.session().openConversation(2, "sidebar"));
  await React.act(async () => mounted.session().send("question"));
  await until(() => fixture.streams.length === 1);
  await React.act(async () => {
    fixture.streams[0].reject(new Error("boom"));
    await until(() => mounted.session().messages.at(-1)?.content.includes("boom"));
  });
  const before = mounted.session().messages;
  const readsBefore = reads;
  const revision = fixture.state().selectionRevision;
  await React.act(async () => mounted.session().openConversation(2, "sidebar"));
  assert.equal(fixture.state().selectionRevision, revision);
  assert.equal(reads, readsBefore);
  assert.equal(mounted.session().loading, false);
  assert.equal(mounted.session().messages, before);
});

test("clicking the open conversation retries a load that failed", async (t) => {
  let reads = 0;
  const fixture = await setupChatTurns(t, {
    getAgentConversation: async (id) => {
      reads += 1;
      if (reads === 1) throw new Error("offline");
      return { id, messages: [], note_id: null };
    },
  });
  const mounted = await mountSession(t, fixture);
  await React.act(async () => mounted.session().openConversation(2, "sidebar"));
  assert.ok(mounted.session().error);
  await React.act(async () => mounted.session().openConversation(2, "sidebar"));
  assert.equal(mounted.session().error, null);
});

test("a stale load error doesn't show on a pending submission", async (t) => {
  const creation = deferred();
  const fixture = await setupChatTurns(t, {
    createAgentConversation: () => creation.promise,
    getAgentConversation: async () => {
      throw new Error("offline");
    },
  });
  const mounted = await mountSession(t, fixture);
  await React.act(async () => mounted.session().openConversation(2, "sidebar"));
  assert.ok(mounted.session().error);
  await React.act(async () => mounted.session().newChat());
  await React.act(async () => mounted.session().send("question"));
  assert.equal(mounted.session().selection.kind, "submission");
  assert.equal(mounted.session().error, null);
  assert.equal(mounted.session().messages.length, 1);
});

test("another conversation's streaming doesn't re-render the one on screen", async (t) => {
  const fixture = await setupChatTurns(t);
  const { store } = fixture;
  const mounted = await mountSession(t, fixture);
  await React.act(async () => mounted.session().openConversation(1, "sidebar"));
  await React.act(async () => mounted.session().send("background question"));
  await until(() => fixture.streams.length === 1);
  await React.act(async () => mounted.session().openConversation(2, "sidebar"));
  await flush();
  const update = (change) => React.act(async () => store.useChatTurnStore.setState(change));
  const chunk = (key) => (state) => ({
    entries: {
      ...state.entries,
      [key]: { ...state.entries[key], toolStatus: `${state.entries[key].toolStatus}.` },
    },
  });

  let before = mounted.renders();
  await update(chunk("conversation:1"));
  await update((state) => ({ listRevision: state.listRevision + 1 }));
  await update((state) => ({ drafts: { ...state.drafts, 1: "elsewhere" } }));
  assert.equal(mounted.renders(), before);

  await React.act(async () => mounted.session().send("question on screen"));
  await until(() => fixture.streams.length === 2);
  await flush();
  const skills = mounted.session().skills;
  before = mounted.renders();
  await update(chunk("conversation:2"));
  assert.equal(mounted.renders(), before + 1, "its own chunk still renders");
  assert.equal(mounted.session().toolStatus, ".");
  assert.equal(mounted.session().skills, skills, "skills aren't read back on every chunk");
});

for (const [event, changedId, unmount = false] of [
  ["onNoteUpdated", 2],
  ["onNoteUpdated", 1],
  ["onNoteDeleted", 1],
  ["onNoteUpdated", 1, true],
  ["onNoteUpdated", 2, true],
  ["onNoteSynced", 1, true],
  ["onNoteSynced", 2, true],
  ["onNoteDeleted", 1, true],
  ["onNoteDeleted", 2, true],
  ["onSpacePurged", 2],
  ["onFolderDeleted", 9],
  ["onSpacePurged", 2, true],
  ["onFolderDeleted", 9, true],
]) {
  test(`background note context follows ${event} for ${changedId} ${unmount ? "after leaving Chat" : "while setup waits"}`, async (t) => {
    const listeners = new Set();
    const skills = deferred();
    let readingSkills = false;
    const fixture = await setupChatTurns(t, {
      getAgentConversation: async (id) => ({ id, note_id: id, messages: [] }),
      getNote: async (id) => ({
        id,
        title: `Note ${id}`,
        content: `Source content ${id}`,
        transcript: "",
        folder_id: 9,
        space_id: 2,
      }),
      getSpeakerMappings: async () => [],
      [event]: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      skillsList: () => {
        readingSkills = true;
        return skills.promise;
      },
    });
    const mounted = await mountSession(t, fixture);
    await React.act(async () => {
      await mounted.session().openConversation(1, "sidebar");
      await flush();
    });
    await React.act(async () => {
      assert.equal(mounted.session().send("What does my source note say?"), true);
      await until(() => readingSkills);
    });
    if (unmount) await mounted.unmount();
    else
      await React.act(async () => {
        await mounted.session().openConversation(2, "sidebar");
        await flush();
      });
    await React.act(async () => {
      const payload = event === "onSpacePurged" ? { spaceId: changedId } : { id: changedId };
      for (const listener of listeners) listener(payload);
      await flush();
    });
    await React.act(async () => {
      skills.resolve({ skills: [] });
      await until(() => fixture.streams.length === 1);
    });
    const prompt = fixture.streams[0].messages[0].content;
    assert.equal(
      prompt.includes("Source content 1"),
      ["onNoteUpdated", "onNoteSynced", "onNoteDeleted"].includes(event) && changedId !== 1
    );
    assert.doesNotMatch(prompt, /Source content 2/);
    assert.equal(listeners.size, unmount ? 1 : 2, "the pending turn keeps its subscription");
    await React.act(async () => {
      fixture.streams[0].resolve("Answer");
      await until(() => !fixture.state().entries["conversation:1"]?.running);
    });
    assert.equal(listeners.size, unmount ? 0 : 1, "the settled turn releases its subscription");
  });
}
