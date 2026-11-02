const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { setupChatTurns, until, flush } = require("../lib/chatTurnHarness");
const mocks = {
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
  assert.deepEqual(
    fixture.writes.map(({ id, content }) => [id, content]),
    [
      [firstId, "A"],
      [secondId, "B"],
      [secondId, "B answer"],
      [firstId, "A answer"],
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
