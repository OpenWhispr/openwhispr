const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { click, findAll, label, settle } = require("../lib/skillsHarness");

// ChatView with a conversation already open: persistence reports the note it was
// started from, and the note comes from a faked getNote.
const MOCKS = {
  "/hooks/useAuth": `export const useAuth = () => ({ isLoaded: true, isSignedIn: !!globalThis.__user, user: globalThis.__user ?? null });`,
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

async function renderChatView(t, { noteId, note, user = null }) {
  let root = null;
  const opened = [];
  const noteListeners = new Set();
  let currentNote = note;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__noteId;
    delete globalThis.__user;
    delete globalThis.__chatInput;
    delete globalThis.__chatStreamingOptions;
  });
  globalThis.__noteId = noteId;
  globalThis.__user = user;
  const subscribe = (listener) => {
    noteListeners.add(listener);
    return () => noteListeners.delete(listener);
  };
  installBrowserGlobals(t, {
    window: {
      addEventListener() {},
      removeEventListener() {},
      electronAPI: {
        getNote: async (id) => (id === currentNote?.id ? currentNote : null),
        getSpeakerMappings: async () => [],
        onNoteUpdated: subscribe,
        onNoteSynced: subscribe,
        onNoteDeleted: subscribe,
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
  const render = async () => {
    await React.act(async () =>
      root.render(React.createElement(ChatView, { onOpenNote: (target) => opened.push(target) }))
    );
    await settle();
  };
  await render();
  return {
    container,
    opened,
    // The open conversation's note changes, as persistence reports it.
    setNoteId: async (id) => {
      globalThis.__noteId = id;
      await render();
    },
    // The note changes elsewhere, and main broadcasts it.
    editNote: async (changes) => {
      currentNote = { ...currentNote, ...changes };
      for (const listener of noteListeners) listener(currentNote);
      await settle();
    },
  };
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

const MEETING_TRANSCRIPT = JSON.stringify([
  { text: "I will send the deck", source: "mic", speaker: "you" },
  { text: "Thanks, I'll review it", source: "system", speaker: "speaker_1" },
]);

test("grounding says the user took the notes when they recorded them", async (t) => {
  await renderChatView(t, {
    noteId: NOTE.id,
    note: {
      ...NOTE,
      transcript: MEETING_TRANSCRIPT,
      cloud_id: "cloud-5",
      created_by_user_id: "u1",
    },
    user: { id: "u1", name: "Chad", email: "chad@example.com" },
  });

  const { text } = globalThis.__chatStreamingOptions.openNote(Infinity);
  assert.match(text, /Meeting Context/);
  assert.match(text, /Chad/);
  assert.match(text, /I will send the deck/);
});

test("grounding says someone else took a teammate's notes", async (t) => {
  await renderChatView(t, {
    noteId: NOTE.id,
    note: {
      ...NOTE,
      transcript: MEETING_TRANSCRIPT,
      cloud_id: "cloud-5",
      created_by_user_id: "u2",
    },
    user: { id: "u1", name: "Chad", email: "chad@example.com" },
  });

  const { text } = globalThis.__chatStreamingOptions.openNote(Infinity);
  assert.match(text, /Someone other than the user took these notes/);
  assert.doesNotMatch(text, /Chad/);
});

test("an edit to the note elsewhere reaches the bar and the next send", async (t) => {
  const { container, editNote } = await renderChatView(t, { noteId: NOTE.id, note: NOTE });

  await editNote({ title: "Q4 planning sync", content: "Action items: send the deck." });
  assert.match(container.textContent, /Q4 planning sync/);
  assert.match(globalThis.__chatStreamingOptions.openNote(Infinity).text, /send the deck/);
  assert.equal(globalThis.__chatInput.placeholder, "Ask about Q4 planning sync...");

  await editNote({ deleted_at: "2026-10-30T10:00:00.000Z" });
  assert.match(container.textContent, /This note was deleted/);
  assert.equal(globalThis.__chatStreamingOptions.openNote, undefined);
});

test("switching conversations keeps the bar steady but never grounds in the old note", async (t) => {
  const { container, setNoteId } = await renderChatView(t, { noteId: NOTE.id, note: NOTE });

  // The next conversation is loading: its note isn't known yet.
  await setNoteId(undefined);
  assert.match(container.textContent, /Q3 planning sync/, "the bar doesn't flash out");
  assert.equal(globalThis.__chatStreamingOptions.openNote, undefined);

  await setNoteId(NOTE.id);
  assert.equal(typeof globalThis.__chatStreamingOptions.openNote, "function");

  // A plain chat drops the bar.
  await setNoteId(undefined);
  await setNoteId(null);
  assert.doesNotMatch(container.textContent, /Open note/);
});

test("a long note title is shortened in the composer placeholder", async (t) => {
  await renderChatView(t, {
    noteId: NOTE.id,
    note: { ...NOTE, title: "Weekly product sync with the design team and the platform group" },
  });

  assert.equal(
    globalThis.__chatInput.placeholder,
    "Ask about Weekly product sync with the design team..."
  );
});
