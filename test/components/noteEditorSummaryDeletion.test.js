const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Walk the element tree the component returned and collect the segmented-control
// buttons by their data-segment-value, with the className that decides the pill.
function collectSegments(node, out = new Map()) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectSegments(child, out);
    return out;
  }
  const props = node.props;
  if (!props) return out;
  if (props["data-segment-value"]) {
    out.set(props["data-segment-value"], String(props.className ?? ""));
  }
  collectSegments(props.children, out);
  return out;
}

// Every `value` a rich-text editor in the tree was handed — the body content.
function collectEditorValues(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectEditorValues(child, out);
    return out;
  }
  const props = node.props;
  if (!props) return out;
  if (typeof props.value === "string") out.push(props.value);
  collectEditorValues(props.children, out);
  return out;
}

function activeSegment(segments) {
  // The active tab is the one rendered with the full-strength label colour;
  // the inactive ones get text-foreground/60.
  const active = [];
  for (const [value, className] of segments) {
    if (/(^|\s)text-foreground($|\s)/.test(className)) active.push(value);
  }
  return active;
}

const NOTE = {
  id: 1,
  client_note_id: "note-1",
  cloud_id: null,
  title: "Kickoff",
  content: "plain notes body",
  enhanced_content: "AI summary body",
  transcript: "",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  space_id: null,
  folder_id: null,
};

function baseProps(enhancement) {
  return {
    note: { ...NOTE, enhanced_content: enhancement ? enhancement.content : null },
    onTitleChange() {},
    onContentChange() {},
    isSaving: false,
    isRecording: false,
    isProcessing: false,
    onStartRecording() {},
    onStopRecording() {},
    enhancement,
  };
}

async function loadNoteEditor(t) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getSpeakerProfiles: async () => [],
        getSpeakerMappings: async () => [],
        updateNote: async () => ({}),
      },
      requestAnimationFrame: (cb) => {
        cb();
        return 1;
      },
      cancelAnimationFrame() {},
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
    cachePrefix: "openwhispr-note-editor-summary-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        const i18n = { resolvedLanguage: "en", language: "en" };
        export function useTranslation() { return { t, i18n }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ui/RichTextEditor": `
        export function RichTextEditor(props) { return null; }
      `,
      "./MeetingTranscriptChat": `
        export function MeetingTranscriptChat() { return null; }
        export function SelectionBar() { return null; }
      `,
      "/EmbeddedChat": `export default function EmbeddedChat() { return null; }`,
      "/hooks/useAuth": `export function useAuth() { return { isSignedIn: false, user: null }; }`,
      "/hooks/useEmbeddedChat": `
        export function useEmbeddedChat() {
          return { messages: [], send() {}, reset() {}, isStreaming: false, containerRef: { current: null } };
        }
      `,
      "/services/NoteSharingService": `export const NoteSharingService = { fetchAcl: async () => null };`,
      "/hooks/useSpaceRoster": `export async function fetchSpaceRoster() { return []; }`,
    },
  });

  const mod = await vite.ssrLoadModule("/components/notes/NoteEditor.tsx");
  const NoteEditor = mod.default;

  const renders = [];
  function Harness({ enhancement }) {
    // Run the real component body + hooks under React's lifecycle without
    // mounting host elements (the harness DOM has no layout), then assert on
    // the tree it returned.
    renders.push(NoteEditor(baseProps(enhancement)));
    return null;
  }

  const root = createRoot(container);
  return { root, renders, Harness };
}

test("deleting the AI summary leaves an orphaned selected tab", async (t) => {
  const { root, renders, Harness } = await loadNoteEditor(t);
  const enhancement = { content: "AI summary body", isStale: false, onChange() {} };

  await React.act(async () => {
    root.render(React.createElement(Harness, { enhancement }));
  });

  const withSummary = collectSegments(renders.at(-1));
  assert.deepEqual([...withSummary.keys()].sort(), ["enhanced", "raw", "transcript"]);
  assert.deepEqual(activeSegment(withSummary), ["enhanced"], "AI Summary starts selected");

  // The user clears the summary text: RichTextEditor emits "", the draft stores
  // "", and PersonalNotesView stops passing an enhancement at all.
  await React.act(async () => {
    root.render(React.createElement(Harness, { enhancement: undefined }));
  });

  const afterDelete = collectSegments(renders.at(-1));
  assert.deepEqual(
    [...afterDelete.keys()].sort(),
    ["raw", "transcript"],
    "the AI Summary button is gone"
  );
  // The body already falls back — only the tab strip disagrees with it.
  assert.ok(
    collectEditorValues(renders.at(-1)).includes(NOTE.content),
    "the body renders the plain notes content"
  );
  assert.deepEqual(
    activeSegment(afterDelete),
    ["raw"],
    "selection falls back to Your notes instead of pointing at a tab that no longer exists"
  );

  await React.act(async () => root.unmount());
});
