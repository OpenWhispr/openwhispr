const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

const NOTE = {
  id: 5,
  title: "Loose thoughts",
  content: "Body text",
  enhanced_content: "Summary text",
  transcript: "",
  participants: null,
  note_type: "personal",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  audio_duration_seconds: null,
  folder_id: null,
};

const MOCKS = {
  "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
  "/hooks/useUiLocale": `export const useUiLocale = () => "en";`,
  "/ui/useToast": `export const useToast = () => ({ toast: (arg) => globalThis.__log.push(["toast", arg.title]) });`,
  "/ui/MarkdownRenderer": `export const MarkdownRenderer = ({ content }) => content;`,
  "./MeetingTranscriptChat": `export const MeetingTranscriptChat = () => null;`,
  "/hooks/useWorkspace": `export const useSpacesInWorkspaceScope = (spaces) => spaces;`,
  "/stores/noteStore": `
    export const useSpaces = () => [{ id: 1, kind: "private", workspace_id: "ws-1" }];
    export const openNote = (note) => globalThis.__log.push(["openNote", note]);
  `,
  "/stores/deviceNotesStore": `
    const state = {
      closeView: () => globalThis.__log.push(["closeView"]),
      move: async (request, context) => {
        globalThis.__log.push(["move", request, context]);
        return { moved: [{ id: 5, space_id: 1, folder_id: null }] };
      },
    };
    export const useDeviceNotesStore = (select) => select(state);
  `,
};

const click = (button) =>
  React.act(async () => button.dispatchEvent({ type: "click", bubbles: true, button: 0 }));

async function mount(t, getDeviceNote) {
  let root;
  globalThis.__log = [];
  const writes = [];
  const writer = (name) => async () => writes.push(name);
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__log;
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getDeviceNote,
        updateNote: writer("updateNote"),
        saveNote: writer("saveNote"),
        deleteNote: writer("deleteNote"),
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-device-note-view-test-",
    mockModules: MOCKS,
  });
  const { DeviceNoteView } = await vite.ssrLoadModule("/components/notes/DeviceNoteView.tsx");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(DeviceNoteView, { id: 5 })));
  await React.act(async () => {});
  return { container, writes, log: globalThis.__log };
}

test("renders the note read-only with the banner", async (t) => {
  const { container } = await mount(t, async () => NOTE);
  const text = container.textContent;
  for (const expected of [
    "Loose thoughts",
    "Body text",
    "Summary text",
    "notes.deviceNotes.banner",
    "notes.deviceNotes.moveNote",
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.equal(container.querySelector('[contenteditable="true"]'), null);
});

test("Move to my Private opens the moved note", async (t) => {
  const { container, log } = await mount(t, async () => NOTE);
  const button = container.querySelectorAll("button")[0];
  await click(button);
  await React.act(async () => {});
  assert.deepEqual(
    log.find((e) => e[0] === "move"),
    ["move", { noteIds: [5] }, { workspaceId: "ws-1" }]
  );
  assert.deepEqual(log.find((e) => e[0] === "openNote")[1], {
    id: 5,
    space_id: 1,
    folder_id: null,
  });
  assert.ok(log.some((e) => e[0] === "closeView"));
});

test("never calls a note write IPC", async (t) => {
  const { container, writes } = await mount(t, async () => NOTE);
  await click(container.querySelectorAll("button")[0]);
  await React.act(async () => {});
  assert.deepEqual(writes, []);
});

test("closes when the note is no longer available", async (t) => {
  const { container, log } = await mount(t, async () => null);
  assert.ok(log.some((e) => e[0] === "closeView"));
  assert.equal(container.textContent, "");
});
