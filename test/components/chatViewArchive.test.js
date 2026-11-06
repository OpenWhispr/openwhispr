const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { setupChatTurns } = require("../lib/chatTurnHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { SKILLS_MOCKS, click, findAll, label, settle } = require("../lib/skillsHarness");

// ChatView with its real sidebar, over a faked conversation table. The menu's items are
// always shown, without Radix's portal.
const MOCKS = {
  "react-i18next": SKILLS_MOCKS["react-i18next"],
  "/ui/useToast": `export const useToast = () => ({ toast: (props) => globalThis.__chatToasts.push(props) });`,
  "/ChatInput": `
    import { createElement } from "react";
    export function ChatInput() { return createElement("textarea"); }
  `,
  "/ChatMessages": `export function ChatMessages() { return null; }`,
  "/ui/dialog": `export function ConfirmDialog() { return null; } export function AlertDialog() { return null; }`,
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
  const toasts = [];
  globalThis.__chatToasts = toasts;
  t.after(() => {
    delete globalThis.__chatToasts;
  });
  const setArchivedAt = (id, archivedAt) => {
    rows = rows.map((row) => (row.id === id ? { ...row, archived_at: archivedAt } : row));
    return { success: true };
  };
  const fixture = await setupChatTurns(
    t,
    {
      getAgentConversationsWithPreview: async (_limit, _offset, archived) =>
        rows.filter((row) => !!row.archived_at === !!archived),
      getAgentConversation: async (id) => {
        const conversation = rows.find((row) => row.id === id);
        return conversation ? { ...conversation, messages: [] } : null;
      },
      archiveAgentConversation: async (id) => setArchivedAt(id, "2026-11-02T09:00:00.000Z"),
      unarchiveAgentConversation: async (id) => setArchivedAt(id, null),
    },
    MOCKS,
    { noExternal: ["react-i18next"] }
  );
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  const container = installInteractiveDom(t);
  const { default: ChatView } = await fixture.vite.ssrLoadModule("/components/chat/ChatView.tsx");
  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  fixture.unmounts.push(async () => React.act(async () => root.unmount()));
  await React.act(async () => root.render(React.createElement(ChatView)));
  await settle();

  const buttons = (predicate) =>
    findAll(container, (node) => node.nodeName === "BUTTON" && predicate(node));
  const row = (title) => buttons((node) => node.textContent.includes(title))[0];
  const toggle = () => buttons((node) => label(node) === "chat.archived")[0];
  return {
    toasts,
    activeConversationId: () => {
      const selection = fixture.state().selection;
      return selection.kind === "conversation" ? selection.conversationId : null;
    },
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
  assert.equal(list.activeConversationId(), 2);

  await list.pickFromMenu("Trip planning", "chat.unarchive");

  assert.equal(list.activeConversationId(), 2);
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
  assert.equal(list.activeConversationId(), 2);

  await list.pickFromMenu("Trip planning", "chat.unarchive");

  assert.ok(!list.toggle(), "retry restored the last archived chat");
  assert.ok(list.showing("Trip planning"));
  assert.equal(list.activeConversationId(), 2);
  assert.equal(list.toasts.length, 1);
});

test("Archive moves the chat to the Archived list and closes it when open", async (t) => {
  const list = await renderChatView(t, [chat(1, "Standup recap"), chat(2, "Trip planning")]);
  await list.open("Standup recap");
  assert.equal(list.activeConversationId(), 1);

  await list.pickFromMenu("Standup recap", "chat.archive");

  assert.equal(list.activeConversationId(), null);
  assert.ok(!list.showing("Standup recap"), "it left the active list");
  assert.ok(list.showing("Trip planning"));
  await list.toggleArchivedView();
  assert.ok(list.showing("Standup recap"), "it is in the Archived list");
  assert.ok(!list.showing("Trip planning"));
});
