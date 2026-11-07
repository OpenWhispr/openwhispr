const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { setupChatTurns, until, flush } = require("../lib/chatTurnHarness");
const mocks = {
  "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
  "/ChatInput": `export function ChatInput(props) { globalThis.__backgroundInput = props; return null; }`,
  "/ChatMessages": `export function ChatMessages(props) { globalThis.__backgroundMessages = props; return null; }`,
  "/ConversationList": `export default function ConversationList(props) { globalThis.__backgroundList = props; return null; }`,
  "/NewChatEmptyState": `export function NewChatEmptyState() { return null; }`,
  "/ui/dialog": `export function ConfirmDialog() { return null; } export function AlertDialog() { return null; }`,
};
async function renderView(t) {
  const fixture = await setupChatTurns(t, {}, mocks);
  const container = installInteractiveDom(t);
  const { default: ChatView } = await fixture.vite.ssrLoadModule("/components/chat/ChatView.tsx");
  const root = createRoot(container);
  let mounted = true;
  fixture.unmounts.push(async () => {
    if (mounted) await React.act(async () => root.unmount());
  });
  await React.act(async () => root.render(React.createElement(ChatView)));
  return {
    ...fixture,
    input: () => globalThis.__backgroundInput,
    list: () => globalThis.__backgroundList,
    async unmount() {
      await React.act(async () => root.unmount());
      mounted = false;
    },
  };
}
test("main Chat keeps A alive through New chat, B, and unmount with writes bound to their rows", async (t) => {
  const fixture = await renderView(t);
  await React.act(async () => {
    fixture.input().onTextSubmit("A");
    await until(() => fixture.streams.length === 1);
  });
  const firstId = fixture.state().selection.conversationId;
  await React.act(async () => fixture.list().onNewChat());
  assert.equal(fixture.streams[0].signal.aborted, false);
  assert.equal(fixture.input().agentState, "idle");
  await React.act(async () => {
    fixture.input().onTextSubmit("B");
    await until(() => fixture.streams.length === 2);
  });
  const secondId = fixture.state().selection.conversationId;
  await fixture.unmount();
  fixture.streams[1].resolve("B answer");
  fixture.streams[0].resolve("A answer");
  await until(() => Object.values(fixture.state().entries).every((entry) => !entry.running));
  // Each reply's row is saved when its turn starts and completed in place.
  assert.deepEqual(
    fixture.writes.map(({ id, content }) => [id, content]),
    [
      [firstId, "A"],
      [firstId, "A answer"],
      [secondId, "B"],
      [secondId, "B answer"],
    ]
  );
});
test("main Chat keeps per-conversation drafts and restores rejected text", async (t) => {
  const fixture = await renderView(t);
  await React.act(async () => fixture.list().onSelectConversation(2));
  await React.act(async () => fixture.input().onDraftChange("draft A"));
  await React.act(async () => fixture.list().onSelectConversation(3));
  await React.act(async () => fixture.input().onDraftChange("draft B"));
  await React.act(async () => fixture.list().onSelectConversation(2));
  assert.equal(fixture.input().draftText, "draft A");
  await React.act(async () => {
    fixture.policy.setState({ status: "loading" });
    fixture.input().onDraftChange("");
    fixture.input().onTextSubmit("rejected question");
    await flush();
  });
  assert.equal(fixture.input().draftText, "rejected question");
});
test("while a conversation validates the composer can still be typed in, but can't send", async (t) => {
  const { deferred } = require("../lib/chatTurnHarness");
  const row = deferred();
  const fixture = await setupChatTurns(t, { getAgentConversation: () => row.promise }, mocks);
  const container = installInteractiveDom(t);
  const { default: ChatView } = await fixture.vite.ssrLoadModule("/components/chat/ChatView.tsx");
  const root = createRoot(container);
  fixture.unmounts.push(async () => React.act(async () => root.unmount()));
  await React.act(async () => root.render(React.createElement(ChatView)));
  await React.act(async () => {
    void globalThis.__backgroundList.onSelectConversation(2);
    await flush();
  });
  assert.equal(container.querySelector("fieldset"), null, "a disabled fieldset would drop focus");
  assert.equal(globalThis.__backgroundInput.sendDisabled, true);
  await React.act(async () => globalThis.__backgroundInput.onDraftChange("typed early"));
  assert.equal(globalThis.__backgroundInput.draftText, "typed early");
  await React.act(async () => {
    row.resolve({ id: 2, messages: [], note_id: null });
    await flush();
  });
  assert.equal(globalThis.__backgroundInput.sendDisabled, false);
});
test("a starter card leaves the text typed in New chat alone", async (t) => {
  const fixture = await renderView(t);
  await React.act(async () => fixture.input().onDraftChange("half a thought"));
  await React.act(async () => {
    globalThis.__backgroundMessages.emptyState.props.onPrompt("Starter prompt");
    await until(() => fixture.streams.length === 1);
  });
  await React.act(async () => fixture.list().onNewChat());
  assert.equal(fixture.input().draftText, "half a thought");
});
test("a refused starter card adds to the typed text instead of replacing it", async (t) => {
  const fixture = await renderView(t);
  await React.act(async () => fixture.input().onDraftChange("half a thought"));
  await React.act(async () => {
    fixture.policy.setState({ status: "loading" });
    globalThis.__backgroundMessages.emptyState.props.onPrompt("Starter prompt");
    await flush();
  });
  assert.equal(fixture.input().draftText, "half a thought\n\nStarter prompt");
});

test("reopening a completed store-created chat waits for its persisted messages", async (t) => {
  const { deferred } = require("../lib/chatTurnHarness");
  const reloaded = deferred();
  let reopening = false;
  const fixture = await setupChatTurns(
    t,
    { getAgentConversation: async (id) => (reopening ? reloaded.promise : { id, messages: [] }) },
    mocks
  );
  const container = installInteractiveDom(t);
  const { default: ChatView } = await fixture.vite.ssrLoadModule("/components/chat/ChatView.tsx");
  const root = createRoot(container);
  fixture.unmounts.push(async () => React.act(async () => root.unmount()));
  await React.act(async () => root.render(React.createElement(ChatView)));
  await React.act(async () => {
    globalThis.__backgroundInput.onTextSubmit("Remember this question");
    await until(() => fixture.streams.length === 1);
  });
  const id = fixture.state().selection.conversationId;
  await React.act(async () => {
    fixture.streams[0].resolve("Remember this answer");
    await until(() => !fixture.state().entries[`conversation:${id}`]?.running);
  });
  assert.equal(fixture.state().entries[`conversation:${id}`], undefined);
  await React.act(async () => root.render(null));
  reopening = true;
  await React.act(async () => root.render(React.createElement(ChatView)));
  assert.equal(globalThis.__backgroundInput.sendDisabled, true);
  assert.equal(globalThis.__backgroundMessages.emptyState, null);
  await React.act(async () => {
    reloaded.resolve({ id, messages: fixture.writes, note_id: null });
    await flush();
  });
  assert.equal(globalThis.__backgroundInput.sendDisabled, false);
  assert.deepEqual(
    globalThis.__backgroundMessages.messages.map(({ content }) => content),
    ["Remember this question", "Remember this answer"]
  );
  await React.act(async () => {
    globalThis.__backgroundInput.onTextSubmit("Follow up");
    await until(() => fixture.streams.length === 2);
  });
});
