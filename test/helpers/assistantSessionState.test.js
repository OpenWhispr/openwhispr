const test = require("node:test");
const assert = require("node:assert/strict");

test("closing the Assistant retains its same-session conversation and clears transient work", async () => {
  const { closeAssistantSessionState } = await import("../../src/helpers/assistantSessionState.js");

  assert.deepEqual(
    closeAssistantSessionState({
      conversationId: 42,
      pendingCommand: { id: 7, text: "Follow up" },
      thinking: true,
      busy: true,
      responseReady: true,
      selectionContext: "selected response",
    }),
    {
      conversationId: 42,
      pendingCommand: null,
      thinking: false,
      busy: false,
      responseReady: false,
    }
  );
});

test("pre-stream message persistence keeps the Assistant busy", async () => {
  const { resolveAssistantPanelBusy } = await import("../../src/helpers/assistantSessionState.js");

  assert.equal(
    resolveAssistantPanelBusy({
      agentState: "idle",
      activeToolName: null,
      submissionInFlight: true,
    }),
    true
  );
});

test("retained Assistant history stays blocked until a delayed load resolves", async () => {
  const { restoreAssistantConversation } =
    await import("../../src/helpers/assistantSessionState.js");
  const events = [];
  let resolveLoad;
  const load = new Promise((resolve) => {
    resolveLoad = resolve;
  });

  const restoration = restoreAssistantConversation({
    conversationId: 42,
    loadConversation: () => load,
    onReady: () => events.push("ready"),
    onReset: () => events.push("reset"),
    onError: () => events.push("error"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);

  resolveLoad();
  assert.equal(await restoration, "restored");
  assert.deepEqual(events, ["ready"]);
});

test("failed Assistant history resets before enabling a fresh conversation", async () => {
  const { restoreAssistantConversation } =
    await import("../../src/helpers/assistantSessionState.js");
  const events = [];
  const loadError = new Error("database unavailable");

  assert.equal(
    await restoreAssistantConversation({
      conversationId: 42,
      loadConversation: async () => {
        throw loadError;
      },
      onReady: () => events.push("ready"),
      onReset: () => events.push("reset"),
      onError: (error) => events.push(error === loadError ? "error" : "wrong-error"),
    }),
    "reset"
  );
  assert.deepEqual(events, ["error", "reset", "ready"]);
});
