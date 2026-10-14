const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Correcting who said a line is offered during the recording too (#2353).
// While recording, the live store owns the segments, so the editor must route
// the assignment there instead of writing the persisted transcript it is
// showing after the call.

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node.props) return;
  visit(node);
  walk(node.props.children, visit);
}

// NoteEditor wraps both surfaces in leaf components that subscribe to the live
// store, so the tree names them rather than MeetingTranscriptChat/SelectionBar.
function findByName(tree, name) {
  let found = null;
  walk(tree, (node) => {
    if (!found && typeof node.type === "function" && node.type.name === name) found = node;
  });
  return found;
}

function findTab(tree, value) {
  let found = null;
  walk(tree, (node) => {
    if (!found && node.props["data-segment-value"] === value) found = node;
  });
  return found;
}

const NOTE = {
  id: 1,
  client_note_id: "note-1",
  cloud_id: null,
  title: "Kickoff",
  content: "",
  enhanced_content: null,
  transcript: "",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  space_id: null,
  folder_id: null,
  participants: null,
};

async function loadNoteEditor(t) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getSpeakerProfiles: async () => [],
        getSpeakerMappings: async () => [],
        getActions: async () => [],
      },
    },
  });
  const container = installHookDom(t);
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  t.after(() => {
    delete globalThis.ResizeObserver;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-editor-live-speaker-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        const i18n = { resolvedLanguage: "en", language: "en" };
        export function useTranslation() { return { t, i18n }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ui/RichTextEditor": `
        export function RichTextEditor() { return null; }
      `,
      "./MeetingTranscriptChat": `
        export function MeetingTranscriptChat() { return null; }
        export function SelectionBar() { return null; }
      `,
      "/EmbeddedChat": `export default function EmbeddedChat() { return null; }`,
      "/hooks/useAuth": `export function useAuth() { return { isSignedIn: false, user: null }; }`,
      "/hooks/useEmbeddedChat": `
        export function useEmbeddedChat() {
          return {
            messages: [],
            noteConversations: undefined,
            switchConversation() {},
            agentState: "idle",
            sendMessage() {},
            sendInNewChat() {},
            send() {},
            reset() {},
            isStreaming: false,
            containerRef: { current: null },
          };
        }
      `,
      "/services/NoteSharingService": `
        export const NoteSharingService = {
          fetchAcl: async () => null,
          getShareSettings: () => new Promise(() => {}),
        };
      `,
      "/hooks/useSpaceRoster": `export async function fetchSpaceRoster() { return []; }`,
    },
  });

  const mod = await vite.ssrLoadModule("/components/notes/NoteEditor.tsx");
  const NoteEditor = mod.default;

  const assignments = [];
  const renders = [];
  function Harness() {
    renders.push(
      NoteEditor({
        note: NOTE,
        onTitleChange() {},
        onContentChange() {},
        isSaving: false,
        isRecording: true,
        isProcessing: false,
        onStartRecording() {},
        onStopRecording() {},
        onLiveSegmentSpeakerLock: (segmentIds, displayName, profileId) =>
          assignments.push([[...segmentIds], displayName, profileId]),
      })
    );
    return null;
  }

  const root = createRoot(container);
  const latest = () => renders.at(-1);
  const render = () =>
    React.act(async () => {
      root.render(React.createElement(Harness));
    });
  const act = (fn) => React.act(async () => fn());
  const unmount = () => React.act(async () => root.unmount());
  return { render, act, latest, assignments, unmount };
}

// The transcript tab is not the default for a note without a summary.
async function openTranscript(t) {
  const harness = await loadNoteEditor(t);
  await harness.render();
  await harness.act(() => findTab(harness.latest(), "transcript").props.onClick());
  return harness;
}

test("the live transcript offers line selection while recording", async (t) => {
  const { latest, unmount } = await openTranscript(t);

  const chat = findByName(latest(), "LiveMeetingTranscriptChat");
  assert.ok(chat, "the live transcript renders while recording");
  assert.equal(typeof chat.props.onToggleSelect, "function", "lines can be selected");
  assert.ok(chat.props.selectedSegmentIds instanceof Set);
  assert.equal(chat.props.selectedSegmentIds.size, 0);

  await unmount();
});

test("assigning a selected line while recording goes to the live store", async (t) => {
  const { act, latest, assignments, unmount } = await openTranscript(t);

  await act(() => findByName(latest(), "LiveMeetingTranscriptChat").props.onToggleSelect("seg-2"));

  const bar = findByName(latest(), "LiveSelectionBar");
  assert.ok(bar, "selecting a line raises the assign bar during the recording");
  assert.equal(bar.props.count, 1);

  await act(() => bar.props.onAssignName("Ana", null, 7));
  assert.deepEqual(assignments, [[["seg-2"], "Ana", 7]]);

  // The selection clears, so the bar steps out of the way of the live rows.
  assert.equal(findByName(latest(), "LiveSelectionBar"), null);

  await unmount();
});
