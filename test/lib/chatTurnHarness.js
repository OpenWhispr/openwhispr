const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  SIGNED_OUT_AUTH_MOCK,
} = require("./rendererTestHarness");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(predicate) {
  // These tests wait on real IPC-style turns, and a busy CI runner has taken over 10 s.
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  assert.ok(predicate(), "expected asynchronous chat state");
}
async function setupChatTurns(t, electronAPI = {}, mockModules = {}, rendererOptions = {}) {
  const unmounts = [];
  let cleanup = () => {};
  t.after(async () => {
    for (const unmount of unmounts) await unmount();
    cleanup();
  });
  const writes = [];
  const rows = new Map();
  let nextId = 20;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        createAgentConversation: async (title) => {
          const row = { id: nextId++, title, messages: [] };
          rows.set(row.id, row);
          return row;
        },
        addAgentMessage: async (id, role, content, metadata) => {
          writes.push({ id, role, content, metadata });
          return { id: writes.length };
        },
        // A reply saved while it ran is completed in its row.
        updateAgentMessage: async (rowId, content, metadata) => {
          const write = writes[rowId - 1];
          if (!write) return null;
          Object.assign(write, { content, metadata });
          return { id: rowId };
        },
        getAgentConversation: async (id) =>
          rows.get(id) ?? { id, title: `Chat ${id}`, messages: [] },
        ...electronAPI,
      },
    },
  });
  const vite = await createRendererServer(t, {
    ...rendererOptions,
    mockModules: { ...SIGNED_OUT_AUTH_MOCK, ...mockModules },
  });
  const store = await vite.ssrLoadModule("/stores/chatTurnStore.ts");
  const policy = (await vite.ssrLoadModule("/stores/policyStore.ts")).usePolicyStore;
  policy.setState({ status: "unmanaged", policy: null });
  (await vite.ssrLoadModule("/stores/settingsStore.ts")).useSettingsStore.setState({
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-4b",
    chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
    isSignedIn: false,
  });
  const reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const streams = [];
  t.mock.method(
    reasoning,
    "processTextStreamingAI",
    async function* (messages, _model, _provider, _config, _tools, signal) {
      const result = deferred();
      streams.push({ messages, signal, ...result });
      const value = await result.promise;
      if (value instanceof Error) throw value;
      yield { type: "content", text: value ?? "Answer" };
    }
  );
  cleanup = () => {
    store.resetForAccountChange();
    streams.forEach((stream) => stream.resolve("late"));
    reasoning.destroy();
  };
  const state = () => store.useChatTurnStore.getState();
  const send = (text = "Question", overrides = {}) =>
    store.startChatSend({
      selection: state().selection,
      messages: [],
      text,
      skills: { attached: null, pickOff: false, removed: [] },
      userName: null,
      ...overrides,
    });
  return { store, state, send, streams, writes, rows, vite, policy, unmounts, reasoning };
}
module.exports = { setupChatTurns, deferred, until, flush };
