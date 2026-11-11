const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

// The menu renders its items whenever it's open, and hands the test its open switch.
const MENU_MOCK = {
  "/ui/dropdown-menu": `
    import { createElement } from "react";
    export function DropdownMenu({ open, onOpenChange, children }) {
      globalThis.__chatSwitcher = { onOpenChange };
      return createElement("div", { "data-menu": "" }, open ? children : null);
    }
    const part = ({ children }) => createElement("div", null, children);
    export const DropdownMenuTrigger = part;
    export const DropdownMenuContent = part;
    export const DropdownMenuItem = part;
    export const DropdownMenuLabel = part;
  `,
};

const chat = (id, title, noteSpaceId, noteId = noteSpaceId == null ? null : id + 100) => ({
  id,
  title,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  message_count: 2,
  note_id: noteId,
  note_space_id: noteSpaceId,
});

// M6's rule, as in the Chat list: the switcher leaves out a chat about a note outside the active
// workspace, since opening it would bring that note's replies back as history. Root chats and
// chats whose note is gone stay.
test("the agent window's chat switcher leaves out chats about another workspace's notes", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__chatSwitcher;
  });
  const dom = await installHappyDom(t);
  dom.electronAPI = {
    getAgentConversationsWithPreview: async () => [
      chat(20, "About this workspace's note", 3),
      chat(21, "About another workspace's note", 9),
      chat(22, "A plain chat", null),
      chat(23, "Its note is gone", null, 32),
    ],
    getPrivateSpaceId: async () => 3,
    getSpaces: async () => [
      { id: 3, kind: "private", workspace_id: null },
      { id: 9, kind: "private", workspace_id: "other" },
    ],
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-agent-modal-chat-switcher-test-",
    mockModules: MENU_MOCK,
  });
  const { AgentModal } = await vite.ssrLoadModule("/components/agent/AgentModal.tsx");
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  root = createRoot(host);
  await React.act(async () =>
    root.render(
      React.createElement(AgentModal, {
        bare: false,
        glow: "none",
        conversationId: null,
        onNewChat() {},
        onSelectChat() {},
        onCollapse() {},
        children: "Conversation",
        footer: "Input",
      })
    )
  );
  await React.act(async () => {
    globalThis.__chatSwitcher.onOpenChange(true);
    for (let i = 0; i < 6; i++) await new Promise(setImmediate);
  });

  const menu = host.querySelector("[data-menu]").textContent;
  assert.match(menu, /About this workspace's note/);
  assert.doesNotMatch(menu, /About another workspace's note/);
  assert.match(menu, /A plain chat/);
  assert.match(menu, /Its note is gone/);
});
