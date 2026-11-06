const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { setupChatTurns, until } = require("../lib/chatTurnHarness");

const MOCKS = {
  "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
  "/ChatInput": `import { createElement } from "react"; export function ChatInput(props) { globalThis.__chatInput = props; return createElement("textarea"); }`,
  "/ConversationList": `export default function ConversationList(props) { globalThis.__conversationList = props; return null; }`,
  "/ChatMessages": `export function ChatMessages() { return null; }`,
  "/ui/dialog": `export function ConfirmDialog() { return null; } export function AlertDialog() { return null; }`,
};
async function renderChatView(t, electronAPI = {}) {
  const fixture = await setupChatTurns(t, electronAPI, MOCKS);
  globalThis.window.addEventListener = (type, listener) => {
    if (type === "keydown")
      globalThis.__keydown = (init) => listener({ preventDefault() {}, ...init });
  };
  const container = installInteractiveDom(t);
  const { default: ChatView } = await fixture.vite.ssrLoadModule("/components/chat/ChatView.tsx");
  const root = createRoot(container);
  fixture.unmounts.push(async () => React.act(async () => root.unmount()));
  await React.act(async () => root.render(React.createElement(ChatView)));
  return fixture;
}
for (const [leave, leaveConversation] of Object.entries({
  "New chat": (list) => list.onNewChat(),
  "switching conversation": (list) => list.onSelectConversation(7),
})) {
  test(`${leave} leaves the reply running and frees the new composer immediately`, async (t) => {
    const fixture = await renderChatView(t);
    await React.act(async () => {
      globalThis.__chatInput.onTextSubmit("Search the web for flights");
      await until(() => fixture.streams.length === 1);
    });
    await React.act(async () => leaveConversation(globalThis.__conversationList));
    assert.equal(fixture.streams[0].signal.aborted, false);
    assert.equal(globalThis.__chatInput.agentState, "idle");
    await React.act(async () => {
      globalThis.__chatInput.onTextSubmit("Second question");
      await until(() => fixture.streams.length === 2);
    });
    assert.equal(fixture.streams[0].signal.aborted, false);
  });
}
test("a follow-up after reopening a deleted conversation starts a new one", async (t) => {
  const fixture = await renderChatView(t, {
    getAgentConversation: async (id) => (id === 7 ? null : { id, messages: [] }),
  });
  await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
  await React.act(async () => {
    globalThis.__chatInput.onTextSubmit("A follow-up");
    await until(() => fixture.streams.length === 1);
  });
  assert.equal(fixture.rows.size, 1);
});
for (const [way, startNewChat] of Object.entries({
  "the New chat button": () => globalThis.__conversationList.onNewChat(),
  "the shortcut": () => globalThis.__keydown({ key: "n", metaKey: true, ctrlKey: true }),
})) {
  test(`starting a new chat with ${way} puts the cursor in the composer`, async (t) => {
    await renderChatView(t);
    assert.equal(globalThis.document.activeElement, null);
    await React.act(async () => startNewChat());
    assert.equal(globalThis.document.activeElement?.tagName, "TEXTAREA");
  });
}
