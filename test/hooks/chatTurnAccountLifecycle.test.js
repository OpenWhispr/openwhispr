const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { setupChatTurns, until, flush } = require("../lib/chatTurnHarness");

test("repeated account preparation preserves a turn but replacement clears all account state", async (t) => {
  const { store, state, send, streams } = await setupChatTurns(t);
  store.prepareChatAccountScope("alice");
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send();
  await until(() => streams.length === 1);
  const generation = state().accountGeneration;
  store.prepareChatAccountScope("alice");
  assert.equal(state().accountGeneration, generation);
  assert.equal(streams[0].signal.aborted, false);
  store.prepareChatAccountScope("bob");
  assert.equal(streams[0].signal.aborted, true);
  assert.deepEqual(state().entries, {});
  assert.deepEqual(state().selection, { kind: "new-chat" });
});

test("policy revocation cancels turns without a ChatView and preserves the unsent draft", async (t) => {
  const { store, state, send, streams, policy } = await setupChatTurns(t);
  const unsubscribe = store.subscribeChatPolicy();
  t.after(unsubscribe);
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send();
  await until(() => streams.length === 1);
  store.startNewChat();
  store.setChatDraft(state().selection, "keep me");
  policy.setState({ status: "error" });
  assert.equal(streams[0].signal.aborted, true);
  assert.equal(state().newChatDraft, "keep me");
  assert.equal(send(), false);
});

test("auth reconciliation prepares chat ownership before changing main's account scope", async () => {
  const source = fs.readFileSync(require.resolve("../../src/hooks/useAuth.ts"), "utf8");
  const ast = ts.createSourceFile("useAuth.ts", source, ts.ScriptTarget.Latest, true);
  let runSource;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === "run" &&
      ts.isArrowFunction(node.initializer)
    )
      runSource = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(runSource);
  const calls = [];
  const context = {
    loadAccountDependencies: async () => ({
      syncService: {},
      resetRendererCaches() {},
      prepareChatAccountScope: () => calls.push("chat prepared"),
    }),
    assertAuthGenerationCurrent: async () => {},
    getAuthRequestContextSnapshot: () => ({ observedGeneration: 4 }),
    window: {
      electronAPI: {
        setActiveAccountScope: async () => {
          calls.push("scope changed");
          return { success: false };
        },
      },
    },
    resolvedUserId: "bob",
    boundGeneration: 4,
  };
  const run = vm.runInNewContext(ts.transpile(`(${runSource})`), context);
  await assert.rejects(run());
  assert.deepEqual(calls, ["chat prepared", "scope changed"]);
});

test("main clearing the account scope stops turns even when the session never answers", async (t) => {
  let scopeChanged;
  const { store, state, send, streams } = await setupChatTurns(t, {
    getActiveAccountScope: async () => ({ accountId: "alice", authGeneration: 1 }),
    onActiveAccountScopeChanged: (listener) => {
      scopeChanged = listener;
      return () => {};
    },
  });
  t.after(store.subscribeChatAccountScope());
  await flush();
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send();
  await until(() => streams.length === 1);
  scopeChanged(null);
  assert.equal(streams[0].signal.aborted, true);
  assert.deepEqual(state().entries, {});
});

test("a guest's repeated null scope never touches their turn or draft", async (t) => {
  let scopeChanged;
  const { store, state, send, streams } = await setupChatTurns(t, {
    getActiveAccountScope: async () => null,
    onActiveAccountScopeChanged: (listener) => {
      scopeChanged = listener;
      return () => {};
    },
  });
  t.after(store.subscribeChatAccountScope());
  await flush();
  store.setChatDraft({ kind: "new-chat" }, "keep me");
  store.selectChat({ kind: "conversation", conversationId: 2 });
  send();
  await until(() => streams.length === 1);
  scopeChanged(null);
  scopeChanged(null);
  assert.equal(streams[0].signal.aborted, false);
  assert.equal(state().newChatDraft, "keep me");
});

for (const [file, anchor, first] of [
  ["src/components/SettingsPage.tsx", "const confirmDeleteAccount", "executeAccountDeletion("],
  [
    "src/components/SettingsPage.tsx",
    'title: t("settingsPage.developer.resetAll.title")',
    "signOut()",
  ],
  [
    "src/components/AcceptInvitationModal.tsx",
    "async function handleSwitchAccount",
    "stopRecording()",
  ],
]) {
  test(`chat stops before ${first} after ${anchor}`, () => {
    const source = fs.readFileSync(require.resolve(`../../${file}`), "utf8");
    const start = source.indexOf(anchor);
    assert.ok(start >= 0);
    const reset = source.indexOf("resetChatForAccountChange()", start);
    const next = source.indexOf(first, start);
    assert.ok(next > start);
    assert.ok(reset > start && reset < next);
  });
}
