const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  SIGNED_OUT_AUTH_MOCK,
  createRendererServer,
  installBrowserGlobals,
} = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { SKILLS_MOCKS, click, findAll, label, settle } = require("../lib/skillsHarness");

// ChatView with its real sidebar, over a faked conversation table. The menu's items are
// always shown, without Radix's portal.
const MOCKS = {
  ...SIGNED_OUT_AUTH_MOCK,
  "react-i18next": SKILLS_MOCKS["react-i18next"],
  "/ui/useToast": `export const useToast = () => ({ toast: (props) => globalThis.__chatToasts.push(props) });`,
  "/useChatStreaming": `
    const cancelStream = () => {};
    export function useChatStreaming() {
      return { agentState: "idle", toolStatus: "", activeToolName: "", sendToAI() {}, cancelStream };
    }
  `,
  "/useChatPersistence": `
    export function useChatPersistence({ conversationId }) {
      globalThis.__openConversationId = conversationId;
      return {
        conversationId,
        noteId: null,
        messages: [],
        setMessages() {},
        createConversation: async () => 1,
        saveUserMessage: async () => {},
        saveAssistantMessage() {},
        loadConversation: async (_id, beforeOpen) => {
          beforeOpen?.();
          return true;
        },
        handleNewChat() {},
      };
    }
  `,
  "/ChatInput": `
    import { createElement } from "react";
    export function ChatInput() { return createElement("textarea"); }
  `,
  "/ChatMessages": `export function ChatMessages() { return null; }`,
  "/ui/dialog": `export function ConfirmDialog() { return null; }`,
  "/hooks/useDialogs": `
    export function useDialogs() {
      return { confirmDialog: { open: false }, showConfirmDialog() {}, hideConfirmDialog() {} };
    }
  `,
  "/ui/dropdown-menu": `
    import { createElement } from "react";
    const passThrough = ({ children }) => createElement("div", null, children);
    export const DropdownMenu = passThrough;
    export const DropdownMenuTrigger = passThrough;
    export const DropdownMenuContent = passThrough;
    export const DropdownMenuItem = ({ onClick, children }) =>
      createElement("div", { role: "menuitem", onClick }, children);
    export const DropdownMenuSeparator = () => null;
  `,
};

const chat = (id, title, archived_at = null) => ({
  id,
  title,
  created_at: "2026-11-01T09:00:00.000Z",
  updated_at: "2026-11-01T09:00:00.000Z",
  archived_at,
});

async function renderChatView(t, rows) {
  let root = null;
  const toasts = [];
  globalThis.__chatToasts = toasts;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__openConversationId;
    delete globalThis.__chatToasts;
  });
  const setArchivedAt = (id, archivedAt) => {
    rows = rows.map((row) => (row.id === id ? { ...row, archived_at: archivedAt } : row));
    return { success: true };
  };
  installBrowserGlobals(t, {
    window: {
      addEventListener() {},
      removeEventListener() {},
      electronAPI: {
        getAgentConversationsWithPreview: async (_limit, _offset, archived) =>
          rows.filter((row) => !!row.archived_at === !!archived),
        archiveAgentConversation: async (id) => setArchivedAt(id, "2026-11-02T09:00:00.000Z"),
        unarchiveAgentConversation: async (id) => setArchivedAt(id, null),
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-view-archive-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { default: ChatView } = await vite.ssrLoadModule("/components/chat/ChatView.tsx");
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(ChatView)));
  await settle();

  const buttons = (predicate) =>
    findAll(container, (node) => node.nodeName === "BUTTON" && predicate(node));
  const row = (title) => buttons((node) => node.textContent.includes(title))[0];
  const toggle = () => buttons((node) => label(node) === "chat.archived")[0];
  return {
    toasts,
    toggle,
    showing: (title) => !!row(title),
    toggleArchivedView: async () => {
      await click(toggle());
      await settle();
    },
    open: async (title) => {
      await click(row(title));
      await settle();
    },
    pickFromMenu: async (title, item) => {
      const [menuItem] = findAll(
        row(title),
        (node) => node.getAttribute("role") === "menuitem" && label(node) === item
      );
      assert.ok(menuItem, `${title} offers ${item}`);
      await click(menuItem);
      await settle();
    },
  };
}

test("Unarchive moves the chat from the Archived list back to the active list", async (t) => {
  const list = await renderChatView(t, [
    chat(1, "Standup recap"),
    chat(2, "Trip planning", "2026-10-30T09:00:00.000Z"),
    chat(3, "Old budget", "2026-10-30T09:00:00.000Z"),
  ]);
  await list.toggleArchivedView();
  assert.ok(list.showing("Trip planning"), "the archived chat is listed before unarchiving");

  await list.pickFromMenu("Trip planning", "chat.unarchive");

  assert.ok(!list.showing("Trip planning"), "it left the Archived list");
  assert.ok(list.showing("Old budget"), "the Archived list keeps the other archived chat");
  await list.toggleArchivedView();
  assert.ok(list.showing("Trip planning"), "it is back in the active list");
  assert.ok(list.showing("Standup recap"));
  assert.ok(!list.showing("Old budget"));
});

test("Unarchiving the last archived chat hides the Archived toggle and shows the active list", async (t) => {
  const list = await renderChatView(t, [
    chat(1, "Standup recap"),
    chat(2, "Trip planning", "2026-10-30T09:00:00.000Z"),
  ]);
  await list.toggleArchivedView();

  await list.pickFromMenu("Trip planning", "chat.unarchive");

  assert.ok(!list.toggle(), "the Archived toggle is gone");
  assert.ok(list.showing("Trip planning"));
  assert.ok(list.showing("Standup recap"));
});

test("An open archived chat stays open when it is unarchived", async (t) => {
  const list = await renderChatView(t, [
    chat(1, "Standup recap"),
    chat(2, "Trip planning", "2026-10-30T09:00:00.000Z"),
  ]);
  await list.toggleArchivedView();
  await list.open("Trip planning");
  assert.equal(globalThis.__openConversationId, 2);

  await list.pickFromMenu("Trip planning", "chat.unarchive");

  assert.equal(globalThis.__openConversationId, 2);
});

test("A failed Unarchive shows an error and leaves the chat archived and open for retry", async (t) => {
  const list = await renderChatView(t, [
    chat(1, "Standup recap"),
    chat(2, "Trip planning", "2026-10-30T09:00:00.000Z"),
  ]);
  await list.toggleArchivedView();
  await list.open("Trip planning");
  t.mock.method(console, "error", () => {});
  t.mock.method(
    globalThis.window.electronAPI,
    "unarchiveAgentConversation",
    async () => {
      throw new Error("SQLITE_READONLY");
    },
    { times: 1 }
  );

  await list.pickFromMenu("Trip planning", "chat.unarchive");

  assert.deepEqual(list.toasts, [{ title: "common.error", variant: "destructive" }]);
  assert.ok(list.showing("Trip planning"), "the chat remains in the Archived list");
  assert.equal(globalThis.__openConversationId, 2);

  await list.pickFromMenu("Trip planning", "chat.unarchive");

  assert.ok(!list.toggle(), "retry restored the last archived chat");
  assert.ok(list.showing("Trip planning"));
  assert.equal(globalThis.__openConversationId, 2);
  assert.equal(list.toasts.length, 1);
});

test("Archive moves the chat to the Archived list and closes it when open", async (t) => {
  const list = await renderChatView(t, [chat(1, "Standup recap"), chat(2, "Trip planning")]);
  await list.open("Standup recap");
  assert.equal(globalThis.__openConversationId, 1);

  await list.pickFromMenu("Standup recap", "chat.archive");

  assert.equal(globalThis.__openConversationId, null);
  assert.ok(!list.showing("Standup recap"), "it left the active list");
  assert.ok(list.showing("Trip planning"));
  await list.toggleArchivedView();
  assert.ok(list.showing("Standup recap"), "it is in the Archived list");
  assert.ok(!list.showing("Trip planning"));
});
