const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { click, findAll, label, settle } = require("../lib/skillsHarness");

// ChatView with a conversation already open: persistence reports the note it was
// started from, and the note comes from a faked getNote.
const MOCKS = {
  "/useChatStreaming": `
    import { useCallback } from "react";
    export function useChatStreaming(options) {
      globalThis.__chatStreamingOptions = options;
      const cancelStream = useCallback(() => {}, []);
      return { agentState: "idle", toolStatus: "", activeToolName: "", sendToAI() {}, cancelStream };
    }
  `,
  "/useChatPersistence": `
    export function useChatPersistence() {
      return {
        conversationId: 3,
        noteId: globalThis.__noteId,
        messages: [],
        setMessages() {},
        createConversation: async () => 3,
        saveUserMessage: async () => {},
        saveAssistantMessage() {},
        loadConversation: async () => true,
        getSessionVersion: () => 0,
        handleNewChat() {},
      };
    }
  `,
  "/ChatInput": `
    import { createElement } from "react";
    export function ChatInput(props) {
      globalThis.__chatInput = props;
      return createElement("textarea");
    }
  `,
  "/ConversationList": `export default function ConversationList() { return null; }`,
  "/ChatMessages": `export function ChatMessages() { return null; }`,
  "/ui/dialog": `export function ConfirmDialog() { return null; }`,
  "/hooks/useDialogs": `
    export function useDialogs() {
      return { confirmDialog: { open: false }, showConfirmDialog() {}, hideConfirmDialog() {} };
    }
  `,
};

const NOTE = {
  id: 5,
  title: "Q3 planning sync",
  content: "Ship the three-step flow first.",
  enhanced_content: "Decisions: three-step flow.",
  transcript: "We agreed to ship the three-step flow.",
  folder_id: 9,
  space_id: 2,
  deleted_at: null,
};

async function renderChatView(t, { noteId, note }) {
  let root = null;
  const opened = [];
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__noteId;
    delete globalThis.__chatInput;
    delete globalThis.__chatStreamingOptions;
  });
  globalThis.__noteId = noteId;
  installBrowserGlobals(t, {
    window: {
      addEventListener() {},
      removeEventListener() {},
      electronAPI: {
        getNote: async (id) => (id === note?.id ? note : null),
        getSpeakerMappings: async () => [],
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-view-source-note-test-",
    mockModules: MOCKS,
  });
  const { default: ChatView } = await vite.ssrLoadModule("/components/chat/ChatView.tsx");
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () =>
    root.render(React.createElement(ChatView, { onOpenNote: (target) => opened.push(target) }))
  );
  await settle();
  return { container, opened };
}

const openNoteButton = (container) =>
  findAll(container, (node) => node.nodeName === "BUTTON" && label(node) === "Open note")[0];

test("a chat started from a note names it and opens it", async (t) => {
  const { container, opened } = await renderChatView(t, { noteId: NOTE.id, note: NOTE });

  assert.match(container.textContent, /From/);
  assert.match(container.textContent, /Q3 planning sync/);
  await click(openNoteButton(container));
  assert.deepEqual(opened, [
    { id: 5, title: "Q3 planning sync", folderId: 9, spaceId: 2, deleted: false },
  ]);
});

test("follow-ups in a note chat are grounded in the note", async (t) => {
  await renderChatView(t, { noteId: NOTE.id, note: NOTE });

  const { openNote } = globalThis.__chatStreamingOptions;
  assert.equal(typeof openNote, "function");
  const context = openNote(Infinity);
  assert.equal(context.transcriptPreview, false);
  assert.match(context.text, /Ship the three-step flow first\./);
  assert.match(context.text, /Decisions: three-step flow\./);
  assert.match(context.text, /We agreed to ship the three-step flow\./);
  assert.equal(globalThis.__chatInput.placeholder, "Ask about Q3 planning sync...");
});

test("a deleted source note is named but not linked or used", async (t) => {
  const { container } = await renderChatView(t, {
    noteId: NOTE.id,
    note: { ...NOTE, deleted_at: "2026-10-29T10:00:00.000Z" },
  });

  assert.match(container.textContent, /Q3 planning sync/);
  assert.match(container.textContent, /This note was deleted/);
  assert.equal(openNoteButton(container), undefined);
  assert.equal(globalThis.__chatStreamingOptions.openNote, undefined);
  assert.equal(globalThis.__chatInput.placeholder, "Ask anything...");
});

test("a chat not started from a note has no source bar", async (t) => {
  const { container } = await renderChatView(t, { noteId: null, note: NOTE });

  assert.doesNotMatch(container.textContent, /From|Open note/);
  assert.equal(globalThis.__chatStreamingOptions.openNote, undefined);
  assert.equal(globalThis.__chatInput.placeholder, "Ask anything...");
});
