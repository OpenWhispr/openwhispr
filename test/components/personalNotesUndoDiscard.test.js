const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// PersonalNotesView's delayed saves, seen through the props it hands the
// editor. PersonalNotesView is real; NoteEditor is a stub that exposes them.

const NOTE = {
  id: 11,
  title: "Standup",
  content: "Notes",
  enhanced_content: "Summary",
  transcript: "",
  folder_id: null,
  space_id: 1,
  note_type: "meeting",
};

const MOCKS = {
  "/ui/useToast": `
    const toast = () => "1";
    export const useToast = () => ({ toast, dismiss() {} });
  `,
  "/icons": `export const Plus = () => null; export const Sparkles = () => null;`,
  "./NoteEditor": `
    export default function NoteEditor(props) {
      globalThis.__editorProps = props;
      return null;
    }`,
  "./SpacesTree": `export default () => null;`,
  "/overview/ContainerOverview": `export const ContainerOverview = () => null;`,
  "./NotesStructureIntroDialog": `export default () => null;`,
  "./ActionManagerDialog": `export default () => null;`,
  "./AddNotesToFolderDialog": `export default () => null;`,
  "./NotesOnboarding": `export default () => null;`,
  "/hooks/useActionProcessing": `
    export const useActionProcessing = () => ({ state: "idle", actionName: null, runAction(...args) { globalThis.__noteActionCalls?.push(args); } });
  `,
  "/stores/actionStore": `export const getActionName = (action) => action.name;`,
  "/hooks/useNotesOnboarding": `
    export const useNotesOnboarding = () => ({ isComplete: true, complete() {} });
  `,
  "/hooks/useTeamSpacesCapability": `export const useTeamSpacesCapability = () => false;`,
  "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: false, user: globalThis.__user ?? null });`,
  "/stores/noteStore": `
    const note = () => globalThis.__note;
    export const setActiveNoteId = () => {};
    export const useActiveNoteId = () => note().id;
    export const useActiveNote = () => note();
    export const useNotes = () => [];
    export const useSpaces = () => [];
    export const useFolders = () => [];
    export const useActiveFolderId = () => null;
    export const useActiveContext = () => null;
    export const useIsTreeLoading = () => false;
    export const initializeNotes = async () => {};
    export const initializeNotesTree = async () => {};
    export const loadFolders = async () => {};
    export const setActiveContext = () => {};
    export const revealContainer = () => {};
    export const createFolder = async () => ({ success: false });
    export const getNoteFromStore = () => note();
  `,
};

async function mountView(t, updateNote) {
  const calls = [];
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__editorProps;
    delete globalThis.__note;
  });
  globalThis.__note = NOTE;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNote: async () => NOTE,
        updateNote: async (...args) => {
          calls.push(["save", ...args]);
          return updateNote ? updateNote(...args) : { success: true };
        },
        discardNoteUndo: async (...args) => calls.push(["discard", ...args]),
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-personal-notes-undo-discard-",
    mockModules: MOCKS,
  });
  const { default: PersonalNotesView } = await vite.ssrLoadModule(
    "/components/notes/PersonalNotesView.tsx"
  );
  root = createRoot(container);
  const render = () => React.act(async () => root.render(React.createElement(PersonalNotesView)));
  await render();
  // Re-renders with the store's current note (globalThis.__note).
  Object.defineProperty(calls, "rerender", { value: render });
  Object.defineProperty(calls, "vite", { value: vite });
  return calls;
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const saves = (calls) => calls.filter(([kind]) => kind === "save");

// Typing in the open note retires the assistant's Undo at once, before the
// editor's delayed save: an Undo clicked in that second would restore the
// assistant's previous text over what the user just typed.
test("editing either document retires the assistant's Undo before the delayed save", async (t) => {
  const calls = await mountView(t);

  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));
  assert.deepEqual(calls, [["discard", NOTE.id]], "retired before the save");
  await React.act(async () =>
    globalThis.__editorProps.enhancement.onChange(NOTE.id, "Typed summary")
  );
  assert.deepEqual(calls.at(-1), ["discard", NOTE.id]);
  assert.equal(saves(calls).length, 0);
});

// Keep on the conflict banner saves the draft first: a delayed save landing
// after Keep would write it back over a clear Keep accepted.
test("a flush before Keep saves the pending edits at once, and nothing lands later", async (t) => {
  const calls = await mountView(t);

  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Retitled"));
  await React.act(async () => globalThis.__editorProps.onFlushPendingSaves(NOTE.id));
  assert.deepEqual(saves(calls), [["save", NOTE.id, { title: "Retitled" }]]);
  await React.act(() => settle(1100));
  assert.equal(saves(calls).length, 1, "the delayed save was retired");
});

test("a flush that fails rejects and leaves the edits pending", async (t) => {
  const calls = await mountView(t, () => ({ success: false, error: "Note not found" }));

  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Retitled"));
  await assert.rejects(globalThis.__editorProps.onFlushPendingSaves(NOTE.id), /Note not found/);
  await React.act(() => settle(1100));
  assert.equal(saves(calls).length, 2, "the delayed save still runs");
});

// A pull or ack can apply a clear made elsewhere while a title save waits.
// The editor's notes are then stale: the save writes only the title, and the
// editor then shows the stored notes instead of bringing the cleared text back.
test("a title save after a pull or ack writes only the title, then shows the stored notes", async (t) => {
  const calls = await mountView(t, (id, updates) => ({
    success: true,
    note: { ...globalThis.__note, ...updates },
  }));

  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Retitled"));
  globalThis.__note = { ...NOTE, content: "" };
  await calls.rerender();
  assert.equal(globalThis.__editorProps.note.content, "Notes", "a pending save keeps the draft");
  await React.act(() => settle(1100));
  assert.deepEqual(saves(calls), [["save", NOTE.id, { title: "Retitled" }]]);
  assert.equal(globalThis.__editorProps.note.content, "");
  assert.equal(globalThis.__editorProps.note.title, "Retitled");
});

test("a title edit after a notes edit still saves the notes", async (t) => {
  const calls = await mountView(t);

  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));
  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Retitled"));
  await React.act(() => settle(1100));
  assert.deepEqual(saves(calls), [["save", NOTE.id, { title: "Retitled", content: "Typed" }]]);

  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, ""));
  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Again"));
  await React.act(() => settle(1100));
  assert.deepEqual(saves(calls).at(-1), [
    "save",
    NOTE.id,
    { title: "Again", content: "", clear_fields: ["content"] },
  ]);
});

for (const { name, transcribing, liveNoteId, expectLive } of [
  {
    name: "a stopped meeting's summary reads the saved transcript and speaker names",
    transcribing: false,
    liveNoteId: NOTE.id,
    expectLive: false,
  },
  {
    name: "a meeting still transcribing summarizes its live transcript",
    transcribing: true,
    liveNoteId: NOTE.id,
    expectLive: true,
  },
  {
    name: "another note's live meeting leaves this summary on the saved transcript",
    transcribing: true,
    liveNoteId: NOTE.id + 1,
    expectLive: false,
  },
]) {
  test(name, async (t) => {
    const calls = await mountView(t);
    globalThis.__noteActionCalls = [];
    t.after(() => delete globalThis.__noteActionCalls);
    const { serializeTranscriptSegments } = await calls.vite.ssrLoadModule(
      "/utils/transcriptSpeakerState.ts"
    );
    const { useMeetingRecordingStore } = await calls.vite.ssrLoadModule(
      "/stores/meetingRecordingStore.ts"
    );
    const transcript = serializeTranscriptSegments([
      {
        source: "system",
        timestamp: 100,
        text: "Ship on Friday.",
        speaker: "speaker_0",
        speakerName: "Alice",
        speakerLocked: true,
        speakerLockSource: "user",
      },
      // Named only by its speaker mapping, so the summary has to read the mappings.
      { source: "system", timestamp: 200, text: "Bob reviews it.", speaker: "speaker_1" },
    ]);
    globalThis.__note = { ...NOTE, transcript };
    globalThis.window.electronAPI.getSpeakerMappings = async () => [
      { speaker_id: "speaker_0", display_name: "Alice" },
      { speaker_id: "speaker_1", display_name: "Bob" },
    ];
    await React.act(async () => {
      useMeetingRecordingStore.setState({
        recordingNoteId: liveNoteId,
        isRecording: transcribing,
        isTranscribing: transcribing,
        transcript: "Old live transcript without speaker names.",
      });
    });
    await calls.rerender();
    await React.act(async () => {
      await globalThis.__editorProps.onRunNoteAction({
        id: 1,
        kind: "template",
        name: "Detailed Notes",
        prompt: "Summarize",
        sections: null,
      });
    });
    assert.equal(globalThis.__noteActionCalls.length, 1);
    const [, input, hash] = globalThis.__noteActionCalls[0];
    const source = expectLive ? "Old live transcript without speaker names." : transcript;
    assert.equal(
      hash,
      `${NOTE.content.length + 1 + source.length}-${`${NOTE.content}\n${source}`.slice(0, 50)}`
    );
    if (expectLive) {
      assert.match(input, /Old live transcript/);
      assert.doesNotMatch(input, /Alice: Ship on Friday/);
    } else {
      assert.match(input, /Alice: Ship on Friday/);
      assert.match(input, /Bob: Bob reviews it/);
      assert.doesNotMatch(input, /Old live transcript/);
      globalThis.__note = {
        ...globalThis.__note,
        enhanced_content: "Alice will ship on Friday.",
        enhanced_at_content_hash: hash,
      };
      await calls.rerender();
      assert.equal(globalThis.__editorProps.enhancement.isStale, false);
    }
  });
}

const AI_SUMMARY = {
  id: 2,
  kind: "template",
  name: "AI Summary",
  prompt: "Summarize",
  sections: null,
};
const PARTICIPANTS = JSON.stringify([
  { email: "sam@example.com", displayName: "Sam Rivera", self: true },
  { email: "alice@example.com", displayName: "Alice Ng" },
]);
const USER_AND_INVITEE = [
  { name: "Sam Rivera", email: "sam@example.com" },
  { name: "Alice Ng", email: "alice@example.com" },
];

async function runSummaryOn(t, note, speakerMappings = []) {
  const calls = await mountView(t);
  globalThis.window.electronAPI.getSpeakerMappings = async () => speakerMappings;
  globalThis.__noteActionCalls = [];
  globalThis.__user = { name: "Sam Rivera", email: "sam@example.com" };
  t.after(() => {
    delete globalThis.__noteActionCalls;
    delete globalThis.__user;
  });
  globalThis.__note = { ...NOTE, ...note };
  await calls.rerender();
  await React.act(async () => {
    await globalThis.__editorProps.onRunNoteAction(AI_SUMMARY);
  });
  assert.equal(globalThis.__noteActionCalls.length, 1);
  const [, input, , options] = globalThis.__noteActionCalls[0];
  return { input, options };
}

test("a transcript stored as plain text runs as one, with the user and the invitees for owner mentions", async (t) => {
  const transcript = "Alice, can you fix the build by Friday? Sure, I'll do it.";
  const { input, options } = await runSummaryOn(t, { transcript, participants: PARTICIPANTS });
  assert.equal(options.hasPlainTranscript, true);
  assert.equal(options.isMeetingNote, false, "plain text has no speaker lines to split along");
  assert.deepEqual(options.knownPeople, USER_AND_INVITEE);
  assert.equal(
    input,
    `${NOTE.content}\n\n## Meeting Transcript\n${transcript}`,
    "no Meeting Context, and the transcript as stored"
  );
});

test("a meeting with speakers keeps its Meeting Context, speaker lines and known people", async (t) => {
  const transcript = JSON.stringify([
    { source: "mic", timestamp: 100, text: "I'll send the deck." },
    { source: "system", timestamp: 200, text: "Ship on Friday.", speaker: "speaker_0" },
  ]);
  const { input, options } = await runSummaryOn(t, { transcript, participants: PARTICIPANTS }, [
    { speaker_id: "speaker_0", display_name: "Alice Ng" },
  ]);
  assert.equal(options.isMeetingNote, true);
  assert.ok(!options.hasPlainTranscript);
  assert.deepEqual(options.knownPeople, USER_AND_INVITEE);
  assert.ok(
    input.includes(
      '## Meeting Context\nThe user taking these notes ("Sam Rivera" in the transcript) is Sam Rivera <sam@example.com>.\nInvited participants: Alice Ng <alice@example.com>.'
    ),
    "the owner and the invitee"
  );
  assert.ok(input.includes("Sam Rivera: I'll send the deck.\nAlice Ng: Ship on Friday."));
});

test("a note without a transcript keeps the personal-note run", async (t) => {
  const { input, options } = await runSummaryOn(t, { transcript: "", participants: PARTICIPANTS });
  assert.equal(input, NOTE.content);
  assert.equal(options.isMeetingNote, false);
  assert.ok(!options.hasPlainTranscript);
  assert.deepEqual(options.knownPeople, []);
});

// An upload whose provider returned no segments saves its transcript as the
// note's text and leaves the transcript empty, so that text is the transcript.
test("an upload whose transcript is the note's text runs as a plain transcript", async (t) => {
  const content = "Alice, can you fix the build by Friday? Sure.";
  const { input, options } = await runSummaryOn(t, {
    note_type: "upload",
    content,
    transcript: "",
    participants: null,
  });
  assert.equal(options.hasPlainTranscript, true);
  assert.equal(options.isMeetingNote, false);
  assert.equal(input, `## Meeting Transcript\n${content}`, "not the user's own notes");
  assert.deepEqual(options.material, { notes: "", meetingContext: "", transcript: content });
  assert.deepEqual(options.knownPeople, [{ name: "Sam Rivera", email: "sam@example.com" }]);
});
