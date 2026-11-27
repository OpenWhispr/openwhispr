const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { click, findAll, label, settle } = require("../lib/skillsHarness");
const { until } = require("../lib/chatTurnHarness");

// ChatView with a conversation already open: persistence reports the note it was
// started from, and the note comes from a faked getNote.
const MOCKS = {
  "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
  "/hooks/useAuth": `export const useAuth = () => ({ isLoaded: true, isSignedIn: !!globalThis.__user, user: globalThis.__user ?? null });`,
  // Each send records the note the turn was given. Sends named __probe only read it.
  "/chatTurnEngine": `
    export function createChatTurnEngine(getOptions) {
      return {
        async send(text) {
          const { openNote, openNoteSpaceId } = getOptions();
          globalThis.__chatTurnOpenNote = openNote;
          globalThis.__chatTurnOpenNoteSpaceId = openNoteSpaceId;
          globalThis.__engineSends = (globalThis.__engineSends ?? 0) + 1;
          if (globalThis.__holdGrounding) await globalThis.__holdGrounding.promise;
          if (text !== "__probe") {
            globalThis.__sentContexts.push({ text, context: openNote?.(Infinity) });
          }
        },
        cancel() {},
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
  "/ConversationList": `export default function ConversationList(props) { globalThis.__conversationList = props; return null; }`,
  "/ChatMessages": `export function ChatMessages() { return null; }`,
  "/ui/dialog": `export function ConfirmDialog() { return null; } export function AlertDialog() { return null; }`,
  "/hooks/useDialogs": `
    export function useDialogs() {
      return { confirmDialog: { open: false }, alertDialog: { open: false }, showConfirmDialog() {}, hideConfirmDialog() {}, showAlertDialog() {}, hideAlertDialog() {} };
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

async function renderChatView(t, { noteId, note, user = null, api = {} }) {
  let root = null;
  const opened = [];
  const listeners = new Map();
  const conversations = new Map([[3, { noteId }]]);
  let nextConversationId = 4;
  let pendingConversation = null;
  let currentNote = note;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__user;
    delete globalThis.__chatInput;
    delete globalThis.__chatTurnOpenNote;
    delete globalThis.__engineSends;
    delete globalThis.__holdGrounding;
    delete globalThis.__conversationList;
    delete globalThis.__sentContexts;
  });
  globalThis.__user = user;
  const sent = [];
  globalThis.__sentContexts = sent;
  const subscribe = (event) => (listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(listener);
    return () => listeners.get(event).delete(listener);
  };
  const emit = async (event, payload) => {
    await React.act(async () => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    });
    await settle();
  };
  installBrowserGlobals(t, {
    window: {
      addEventListener() {},
      removeEventListener() {},
      electronAPI: {
        getNote: async (id) => (id === currentNote?.id ? currentNote : null),
        getAgentConversation: async (id) => {
          const row = conversations.get(id);
          return row?.promise ? row.promise : { id, note_id: row?.noteId ?? null, messages: [] };
        },
        addAgentMessage: async () => ({ id: 1 }),
        getSpeakerMappings: async () => [],
        onNoteUpdated: subscribe("updated"),
        onNoteSynced: subscribe("synced"),
        onNoteDeleted: subscribe("deleted"),
        onSpacePurged: subscribe("spacePurged"),
        onFolderDeleted: subscribe("folderDeleted"),
        ...api,
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
  const render = async (props = {}) => {
    await React.act(async () =>
      root.render(
        React.createElement(ChatView, { onOpenNote: (target) => opened.push(target), ...props })
      )
    );
    await settle();
  };
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  await render();
  await React.act(async () => globalThis.__conversationList.onSelectConversation(3));
  await settle();
  return {
    container,
    opened,
    sent,
    emit,
    setUser: async (nextUser) => {
      globalThis.__user = nextUser;
      await render();
    },
    submit: submitAndSettle,
    render,
    // Another conversation opens: undefined while it loads, then its note (or none).
    setNoteId: async (id) => {
      if (id === undefined) {
        const row = deferred();
        pendingConversation = { id: nextConversationId++, row };
        conversations.set(pendingConversation.id, { promise: row.promise });
        void globalThis.__conversationList.onSelectConversation(pendingConversation.id);
      } else if (pendingConversation) {
        const { id: openingId, row } = pendingConversation;
        pendingConversation = null;
        await React.act(async () => row.resolve({ id: openingId, note_id: id, messages: [] }));
      } else {
        const openingId = nextConversationId++;
        conversations.set(openingId, { noteId: id });
        await React.act(async () => globalThis.__conversationList.onSelectConversation(openingId));
      }
      await settle();
      await render();
    },
    // The note changes elsewhere, and main broadcasts it.
    editNote: async (changes) => {
      currentNote = { ...currentNote, ...changes };
      await emit("updated", currentNote);
    },
  };
}

// The note a send made now would be grounded in; none while sending is held back.
async function submitAndSettle(text) {
  const blocked = globalThis.__chatInput.sendDisabled;
  const sends = globalThis.__engineSends ?? 0;
  await React.act(async () => {
    globalThis.__chatInput.onTextSubmit(text);
    if (!blocked) await until(() => (globalThis.__engineSends ?? 0) > sends);
  });
  await settle();
}

async function openNoteNow() {
  if (globalThis.__chatInput.sendDisabled) return undefined;
  await submitAndSettle("__probe");
  return globalThis.__chatTurnOpenNote;
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

  const openNote = await openNoteNow();
  assert.equal(typeof openNote, "function");
  const context = openNote(Infinity);
  assert.equal(context.transcriptPreview, false);
  assert.match(context.text, /Ship the three-step flow first\./);
  assert.match(context.text, /Decisions: three-step flow\./);
  assert.match(context.text, /We agreed to ship the three-step flow\./);
  assert.equal(globalThis.__chatInput.placeholder, "Ask about Q3 planning sync...");
});

test("a note chat names its note's space, so a turn outside that workspace leaves it out", async (t) => {
  await renderChatView(t, { noteId: NOTE.id, note: NOTE });

  assert.equal(typeof (await openNoteNow()), "function");
  assert.equal(globalThis.__chatTurnOpenNoteSpaceId, NOTE.space_id);
});

test("a deleted source note is named but not linked or used", async (t) => {
  const { container } = await renderChatView(t, {
    noteId: NOTE.id,
    note: { ...NOTE, deleted_at: "2026-10-29T10:00:00.000Z" },
  });

  assert.match(container.textContent, /Q3 planning sync/);
  assert.match(container.textContent, /This note was deleted/);
  assert.equal(openNoteButton(container), undefined);
  assert.equal(await openNoteNow(), undefined);
  assert.equal(globalThis.__chatInput.placeholder, "Ask anything...");
});

test("a chat not started from a note has no source bar", async (t) => {
  const { container } = await renderChatView(t, { noteId: null, note: NOTE });

  assert.doesNotMatch(container.textContent, /From|Open note/);
  assert.equal(await openNoteNow(), undefined);
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

  const { text } = (await openNoteNow())(Infinity);
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

  const { text } = (await openNoteNow())(Infinity);
  assert.match(text, /Someone other than the user took these notes/);
  assert.doesNotMatch(text, /Chad/);
});

test("an edit to the note elsewhere reaches the bar and the next send", async (t) => {
  const { container, editNote } = await renderChatView(t, { noteId: NOTE.id, note: NOTE });

  await editNote({ title: "Q4 planning sync", content: "Action items: send the deck." });
  assert.match(container.textContent, /Q4 planning sync/);
  assert.match((await openNoteNow())(Infinity).text, /send the deck/);
  assert.equal(globalThis.__chatInput.placeholder, "Ask about Q4 planning sync...");

  await editNote({ deleted_at: "2026-10-30T10:00:00.000Z" });
  assert.match(container.textContent, /This note was deleted/);
  assert.equal(await openNoteNow(), undefined);
});

test("switching conversations keeps the bar steady but never grounds in the old note", async (t) => {
  const { container, setNoteId } = await renderChatView(t, { noteId: NOTE.id, note: NOTE });

  // The next conversation is loading: its note isn't known yet.
  await setNoteId(undefined);
  assert.match(container.textContent, /Q3 planning sync/, "the bar doesn't flash out");
  assert.equal(await openNoteNow(), undefined);

  await setNoteId(NOTE.id);
  assert.equal(typeof (await openNoteNow()), "function");

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

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("a follow-up waits for source-note loading without starting a fake reply", async (t) => {
  const pending = deferred();
  const chat = await renderChatView(t, {
    noteId: NOTE.id,
    note: NOTE,
    api: { getNote: () => pending.promise },
  });

  await chat.submit("What were the decisions?");
  assert.deepEqual(chat.sent, [], "a pending note must not send an ungrounded question");
  assert.equal(globalThis.__chatInput.sendDisabled, true);
  assert.equal(globalThis.__chatInput.agentState, "idle");

  await React.act(async () => pending.resolve(NOTE));
  await settle();
  await chat.submit("What were the decisions?");
  assert.equal(chat.sent.length, 1);
  assert.match(chat.sent[0].context.text, /three-step flow/);
  assert.equal(globalThis.__chatInput.sendDisabled, false);
});

for (const [event, payload] of [
  ["spacePurged", { spaceId: 2 }],
  ["folderDeleted", { id: 9 }],
]) {
  test(`${event} clears cached grounding before rechecking the source note`, async (t) => {
    const chat = await renderChatView(t, { noteId: NOTE.id, note: NOTE });
    const cachedContext = await openNoteNow();
    const pending = deferred();
    globalThis.window.electronAPI.getNote = () => pending.promise;

    await chat.emit(event, payload);
    assert.equal(await openNoteNow(), undefined);
    assert.equal(
      cachedContext(Infinity).text,
      "",
      "a send already preparing must not reuse revoked content"
    );
    assert.doesNotMatch(chat.container.textContent, /Q3 planning sync/);
    await chat.submit("Summarize this note");
    assert.deepEqual(chat.sent, []);

    await React.act(async () => pending.resolve(null));
    await settle();
    assert.equal(await openNoteNow(), undefined);
    assert.equal(globalThis.__chatInput.sendDisabled, false);
  });

  test(`${event} invalidates a source-note fetch already in flight`, async (t) => {
    const stale = deferred();
    const chat = await renderChatView(t, {
      noteId: NOTE.id,
      note: NOTE,
      api: { getNote: () => stale.promise },
    });
    globalThis.window.electronAPI.getNote = async () => null;
    await chat.emit(event, payload);
    await React.act(async () => stale.resolve(NOTE));
    await settle();

    assert.equal(await openNoteNow(), undefined);
    assert.doesNotMatch(chat.container.textContent, /Q3 planning sync/);
    assert.equal(globalThis.__chatInput.sendDisabled, false);
  });
}

test("a follow-up waits for an edited source note to finish refreshing", async (t) => {
  const chat = await renderChatView(t, { noteId: NOTE.id, note: NOTE });
  const pending = deferred();
  globalThis.window.electronAPI.getNote = () => pending.promise;
  await chat.emit("updated", { id: NOTE.id });
  await chat.submit("What is the current decision?");
  assert.deepEqual(chat.sent, []);
  assert.equal(await openNoteNow(), undefined);

  await React.act(async () => pending.resolve({ ...NOTE, content: "Ship the four-step flow." }));
  await settle();
  await chat.submit("What is the current decision?");
  assert.match(chat.sent[0].context.text, /Ship the four-step flow/);
});

test("changing accounts invalidates pending source-note content", async (t) => {
  const stale = deferred();
  const chat = await renderChatView(t, {
    noteId: NOTE.id,
    note: NOTE,
    user: { id: "user-a" },
    api: { getNote: () => stale.promise },
  });
  globalThis.window.electronAPI.getNote = async () => null;
  await chat.setUser({ id: "user-b" });
  await React.act(async () => stale.resolve(NOTE));
  await settle();
  assert.equal(await openNoteNow(), undefined);
  assert.doesNotMatch(chat.container.textContent, /Q3 planning sync/);
});

test("switching through an unknown source blocks sending until a plain chat is ready", async (t) => {
  const chat = await renderChatView(t, { noteId: NOTE.id, note: NOTE });
  await chat.setNoteId(undefined);
  await chat.submit("Question while switching");
  assert.deepEqual(chat.sent, []);
  assert.equal(globalThis.__chatInput.sendDisabled, true);

  await chat.setNoteId(null);
  await chat.submit("A general question");
  assert.equal(chat.sent.length, 1);
  assert.equal(chat.sent[0].context, undefined);
  assert.equal(globalThis.__chatInput.sendDisabled, false);
});

test("a note update during conversation switching invalidates the same-note cache", async (t) => {
  const chat = await renderChatView(t, { noteId: NOTE.id, note: NOTE });
  await chat.setNoteId(undefined);
  const pending = deferred();
  globalThis.window.electronAPI.getNote = () => pending.promise;
  await chat.emit("updated", { id: NOTE.id });
  await chat.setNoteId(NOTE.id);

  await chat.submit("What is the current decision?");
  assert.deepEqual(chat.sent, [], "the old snapshot must not survive the update while switching");
  assert.equal(globalThis.__chatInput.sendDisabled, true);

  await React.act(async () => pending.resolve({ ...NOTE, content: "Ship the four-step flow." }));
  await settle();
  await chat.submit("What is the current decision?");
  assert.match(chat.sent[0].context.text, /Ship the four-step flow/);
});

// Scratch pin, not from either side: the PR's point is that a turn outlives the view, so a
// turn started in a note chat must keep its note when the user leaves before the engine
// reads it (the engine reads openNote after its async setup).
test("a turn keeps its note when the user switches chat right after sending", async (t) => {
  const chat = await renderChatView(t, { noteId: NOTE.id, note: NOTE });
  globalThis.__holdGrounding = deferred();
  await chat.submit("What were the decisions?");
  await chat.setNoteId(null);
  const { promise, resolve } = globalThis.__holdGrounding;
  delete globalThis.__holdGrounding;
  await React.act(async () => {
    resolve();
    await promise;
  });
  await settle();
  assert.equal(chat.sent.length, 1);
  assert.match(chat.sent[0].context.text, /three-step flow/);
});

test("a skill draft sent from a note's chat starts a new chat without that note", async (t) => {
  const chat = await renderChatView(t, {
    noteId: NOTE.id,
    note: NOTE,
    api: { createAgentConversation: async (title) => ({ id: 40, title, messages: [] }) },
  });
  await chat.render({
    skillRequest: {
      id: 1,
      kind: "create",
      draft: { title: "Standup", description: "Daily notes", instructions: "", fileNames: [] },
    },
  });
  await until(() => chat.sent.length === 1);
  assert.equal(chat.sent[0].context, undefined);
});
