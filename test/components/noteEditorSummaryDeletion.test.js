const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Visit every element in the tree the component returned.
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

// The segmented-control buttons by their data-segment-value.
function collectSegments(tree) {
  const out = new Map();
  walk(tree, (node) => {
    const value = node.props["data-segment-value"];
    if (value) out.set(value, node);
  });
  return out;
}

// Every `value` a rich-text editor in the tree was handed — the body content.
function collectEditorValues(tree) {
  const out = [];
  walk(tree, (node) => {
    if (typeof node.props.value === "string") out.push(node.props.value);
  });
  return out;
}

function activeSegment(segments) {
  // The active tab is the one rendered with the full-strength label colour;
  // the inactive ones get text-foreground/60.
  const active = [];
  for (const [value, node] of segments) {
    const className = String(node.props.className ?? "");
    if (/(^|\s)text-foreground($|\s)/.test(className)) active.push(value);
  }
  return active;
}

// The strip is the element the component measures through its ref; its first
// child is the sliding highlight, positioned through its inline style.
function findSegmentStrip(tree) {
  let strip = null;
  walk(tree, (node) => {
    if (strip) return;
    const children = React.Children.toArray(node.props.children);
    if (children.some((child) => child.props?.["data-segment-button"])) strip = node;
  });
  return strip;
}

function highlightStyle(tree) {
  return React.Children.toArray(findSegmentStrip(tree).props.children)[0].props.style;
}

// The harness DOM has no layout, so the tests hand the component a strip it can
// measure: tabs laid out left to right from the strip's left edge.
const TAB_BOXES = {
  transcript: { left: 2, width: 100, height: 26 },
  raw: { left: 102, width: 90, height: 26 },
  enhanced: { left: 192, width: 110, height: 26 },
};

function measurableStrip(values) {
  const buttons = values.map((value) => ({
    dataset: { segmentValue: value },
    getBoundingClientRect: () => ({ top: 0, ...TAB_BOXES[value] }),
  }));
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 310, height: 30 }),
    querySelectorAll: () => buttons,
  };
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
  participants: JSON.stringify([
    { email: "dana@example.com", displayName: "Dana Wu", responseStatus: null, self: false },
  ]),
};

const ENHANCEMENT = { content: NOTE.enhanced_content, isStale: false, onChange() {} };

// The summary callout runs a template, so the note view needs one loaded.
const TEMPLATE = {
  id: 1,
  client_id: "notes.actions.builtin.detailedNotes",
  kind: "template",
  name: "Detailed Notes",
  description: "",
  prompt: "",
  sections: [{ heading: "Summary", instruction: "" }],
  output: null,
  translation_key: "notes.actions.builtin.detailedNotes",
};
const DEFAULT_TEMPLATE = {
  ...TEMPLATE,
  id: 2,
  client_id: "notes.actions.builtin.generateNotes",
  name: "AI Summary",
  prompt: "Summarize the note.",
  sections: null,
  translation_key: "notes.actions.builtin.generateNotes",
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
        getActions: async () => [TEMPLATE, DEFAULT_TEMPLATE, ...(globalThis.__noteActions ?? [])],
      },
    },
  });
  const container = installHookDom(t);
  const resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      resizeCallbacks.push(callback);
    }
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
      "/hooks/useAuth": `
        export function useAuth() {
          return globalThis.__noteEditorAuth ?? { isSignedIn: false, user: null };
        }
      `,
      "/hooks/useEmbeddedChat": `
        export function useEmbeddedChat(options) {
          globalThis.__embeddedChatOptions = options;
          return {
            messages: globalThis.__embeddedChatMessages ?? [],
            noteConversations: globalThis.__embeddedChatConversations,
            switchConversation() {},
            agentState: globalThis.__embeddedChatAgentState ?? "idle",
            sendMessage: (...args) => globalThis.__embeddedChatSent?.push(args),
            sendInNewChat: (...args) => globalThis.__embeddedChatSent?.push(["new chat", ...args]),
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
          // A signed-in cloud note loads its sharing state; never answered here.
          getShareSettings: () => new Promise(() => {}),
        };
      `,
      "/hooks/useSpaceRoster": `export async function fetchSpaceRoster() { return []; }`,
    },
  });

  const mod = await vite.ssrLoadModule("/components/notes/NoteEditor.tsx");
  const NoteEditor = mod.default;

  const renders = [];
  function Harness({ enhancement, overrides }) {
    // Run the real component body + hooks under React's lifecycle without
    // mounting host elements (the harness DOM has no layout), then assert on
    // the tree it returned.
    renders.push(NoteEditor({ ...baseProps(enhancement), ...overrides }));
    return null;
  }

  const root = createRoot(container);
  const render = (enhancement, overrides) =>
    React.act(async () => {
      root.render(React.createElement(Harness, { enhancement, overrides }));
    });
  // The AI Summary tab wraps its label button and the template chevron.
  const click = (value) =>
    React.act(async () => {
      let target = null;
      walk(collectSegments(renders.at(-1)).get(value), (node) => {
        if (!target && node.props.onClick) target = node;
      });
      target.props.onClick();
    });
  const latest = () => renders.at(-1);
  const unmount = () => React.act(async () => root.unmount());
  return { render, click, latest, unmount, resizeCallbacks };
}

test("deleting the AI summary moves the selection to Your notes", async (t) => {
  const { render, latest, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);
  const withSummary = collectSegments(latest());
  assert.deepEqual([...withSummary.keys()].sort(), ["enhanced", "raw", "transcript"]);
  assert.deepEqual(activeSegment(withSummary), ["enhanced"], "AI Summary starts selected");

  // The user clears the summary text: RichTextEditor emits "", the draft stores
  // "", and PersonalNotesView stops passing an enhancement at all.
  await render(undefined);
  const afterDelete = collectSegments(latest());
  assert.deepEqual(
    [...afterDelete.keys()].sort(),
    ["raw", "transcript"],
    "the AI Summary button is gone"
  );
  // The body already falls back — only the tab strip disagreed with it.
  assert.ok(
    collectEditorValues(latest()).includes(NOTE.content),
    "the body renders the plain notes content"
  );
  assert.deepEqual(
    activeSegment(afterDelete),
    ["raw"],
    "selection falls back to Your notes instead of pointing at a tab that no longer exists"
  );

  await unmount();
});

test("the highlight slides onto Your notes when the summary is deleted", async (t) => {
  const { render, click, latest, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);
  const strip = findSegmentStrip(latest());
  strip.props.ref.current = measurableStrip(["transcript", "raw", "enhanced"]);
  // Take a real measurement over the AI Summary tab, as the app has by the time
  // the user starts deleting.
  await click("transcript");
  await click("enhanced");
  assert.deepEqual(highlightStyle(latest()), {
    width: 110,
    height: 26,
    transform: "translateX(192px)",
    opacity: 1,
  });

  strip.props.ref.current = measurableStrip(["transcript", "raw"]);
  await render(undefined);
  assert.deepEqual(
    highlightStyle(latest()),
    { width: 90, height: 26, transform: "translateX(102px)", opacity: 1 },
    "the highlight moved onto Your notes instead of freezing over the removed tab"
  );

  await unmount();
});

test("hides the highlight instead of freezing it when no tab matches the selection", async (t) => {
  const { render, click, latest, unmount, resizeCallbacks } = await loadNoteEditor(t);

  await render(undefined);
  const strip = findSegmentStrip(latest());
  strip.props.ref.current = measurableStrip(["transcript", "raw"]);
  await click("transcript");
  await click("raw");
  assert.equal(highlightStyle(latest()).opacity, 1);

  // The strip lost the selected tab's button: the net under the whole bug class,
  // reached through the same resize measurement the app performs.
  strip.props.ref.current = measurableStrip(["transcript"]);
  await React.act(async () => resizeCallbacks.at(-1)());
  assert.deepEqual(
    highlightStyle(latest()),
    { width: 90, height: 26, transform: "translateX(102px)", opacity: 0 },
    "the highlight fades in place rather than staying lit over nothing"
  );

  await unmount();
});

test("a typed note without a summary offers one with the default template", async (t) => {
  const { render, latest, unmount } = await loadNoteEditor(t);
  const ran = [];

  await render(undefined, { onRunNoteAction: (action) => ran.push(action.client_id) });
  let callout = null;
  walk(latest(), (node) => {
    if (!callout && "onAskSubmit" in node.props) callout = node.props.callout;
  });
  assert.ok(callout, "notes with no transcript still offer a summary");
  callout.props.onClick();
  assert.deepEqual(ran, [DEFAULT_TEMPLATE.client_id]);

  await unmount();
});

test("the summary callout makes way for the transcript selection bar", async (t) => {
  const { render, click, latest, unmount } = await loadNoteEditor(t);
  const propsWith = (key) => {
    let found = null;
    walk(latest(), (node) => {
      if (!found && key in node.props) found = node.props;
    });
    return found;
  };

  await render(undefined, {
    note: {
      ...NOTE,
      enhanced_content: null,
      transcript: JSON.stringify([{ text: "Hello", source: "mic", timestamp: 0 }]),
    },
    onRunNoteAction() {},
  });
  findSegmentStrip(latest()).props.ref.current = measurableStrip(["transcript", "raw"]);
  await click("transcript");
  assert.ok(propsWith("onAskSubmit").callout, "a transcript without a summary offers one");

  const transcript = propsWith("onToggleSelect");
  await React.act(async () => transcript.onToggleSelect(transcript.segments[0].id));
  assert.ok(propsWith("onAssignName"), "selecting a segment shows the selection bar");
  // Both float in the same bottom strip; the callout would cover the bar's buttons.
  assert.ok(
    !propsWith("onAskSubmit").callout,
    "the callout steps aside while segments are selected"
  );

  await unmount();
});

test("the note's chat gets the note's participants, parsed once", async (t) => {
  t.after(() => {
    delete globalThis.__embeddedChatOptions;
  });
  const { render, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);

  assert.deepEqual(
    globalThis.__embeddedChatOptions.noteParticipants,
    JSON.parse(NOTE.participants)
  );
  assert.equal(globalThis.__embeddedChatOptions.noteId, NOTE.id);
  await unmount();
});

test("the note's chat learns who is viewing the note and its calendar event", async (t) => {
  t.after(() => {
    delete globalThis.__embeddedChatOptions;
    delete globalThis.__noteEditorAuth;
  });
  globalThis.__noteEditorAuth = {
    isSignedIn: true,
    user: { id: "user-chad", email: "chad@example.com" },
  };
  const { render, unmount } = await loadNoteEditor(t);
  const options = () => globalThis.__embeddedChatOptions;

  // A local note is the user's own.
  await render(ENHANCEMENT, { note: { ...NOTE, calendar_event_id: "evt-1" } });
  assert.equal(options().noteOwnedByUser, true);
  assert.equal(options().selfEmail, "chad@example.com");
  assert.equal(options().noteCalendarEventId, "evt-1");

  // A team note someone else recorded is not.
  await render(ENHANCEMENT, {
    note: {
      ...NOTE,
      cloud_id: "cloud-1",
      owner_user_id: "user-alice",
      calendar_event_id: null,
    },
  });
  assert.equal(options().noteOwnedByUser, false);
  assert.equal(options().noteCalendarEventId, null);
  await unmount();
});

test("the note's chat names the user's own speakers and leaves attendees to the attendee block", async (t) => {
  t.after(() => {
    delete globalThis.__embeddedChatOptions;
    delete globalThis.__noteEditorAuth;
  });
  globalThis.__noteEditorAuth = {
    isSignedIn: true,
    user: { id: "user-chad", name: "Chad", email: "chad@example.com" },
  };
  const { render, unmount } = await loadNoteEditor(t);
  const transcript = JSON.stringify([
    { text: "I'll send the deck.", source: "mic", timestamp: 0 },
    { text: "Thanks.", source: "system", timestamp: 3 },
  ]);
  const chatTranscript = () => globalThis.__embeddedChatOptions.noteTranscript;

  await render(ENHANCEMENT, { note: { ...NOTE, transcript } });
  assert.match(chatTranscript(), /Chad: I'll send the deck\./);
  assert.doesNotMatch(chatTranscript(), /Dana Wu|Invited participants/);

  // A teammate's recording: its mic lines are theirs, so the chat keeps it as stored.
  await render(ENHANCEMENT, {
    note: { ...NOTE, transcript, cloud_id: "cloud-1", owner_user_id: "user-alice" },
  });
  assert.equal(chatTranscript(), transcript);
  await unmount();
});

// The note's ask bar.
function findBottomBar(tree) {
  let bar = null;
  walk(tree, (node) => {
    if (!bar && "onAskSubmit" in node.props) bar = node;
  });
  return bar;
}

test("the collapsed composer keeps its send button while the note has no actions", async (t) => {
  const { render, latest, unmount } = await loadNoteEditor(t);
  await render(ENHANCEMENT);
  assert.ok(!findBottomBar(latest()).props.actionPicker);
  await unmount();
});

function findDockedChat(tree) {
  let chat = null;
  walk(tree, (node) => {
    if (!chat && "onSwitchConversation" in node.props) chat = node;
  });
  return chat;
}

const FOLLOW_UP = {
  ...TEMPLATE,
  id: 3,
  client_id: "follow-up",
  kind: "action",
  name: "Follow-up",
  prompt: "Draft a follow-up.",
  sections: null,
  output: "chat",
  translation_key: null,
};

test("a question sent from the ask bar opens the docked chat in a new conversation", async (t) => {
  globalThis.__embeddedChatSent = [];
  t.after(() => delete globalThis.__embeddedChatSent);
  const { render, latest, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);
  await React.act(async () => findBottomBar(latest()).props.onInputFocus());
  assert.equal(findBottomBar(latest()).props.chatOpen, true, "focus still unfolds the bar");
  assert.equal(findDockedChat(latest()), null);

  await React.act(async () => findBottomBar(latest()).props.onAskSubmit("What did we decide?"));
  const bar = findBottomBar(latest());
  assert.equal(bar.props.chatOpen, false);
  assert.equal(bar.props.hideInput, true, "the ask bar folds away");
  assert.ok(findDockedChat(latest()), "the docked chat opens");
  assert.deepEqual(globalThis.__embeddedChatSent, [["new chat", "What did we decide?"]]);
  await unmount();
});

test("the docked chat holds the conversation and its history, and its chips continue it", async (t) => {
  const messages = [{ id: "m1", role: "user", content: "Who owns the copy pass?" }];
  const conversations = [{ id: 7, title: "Copy pass", updated_at: "2026-10-08" }];
  globalThis.__noteActions = [FOLLOW_UP];
  globalThis.__embeddedChatMessages = messages;
  globalThis.__embeddedChatConversations = conversations;
  globalThis.__embeddedChatSent = [];
  t.after(() => {
    delete globalThis.__noteActions;
    delete globalThis.__embeddedChatMessages;
    delete globalThis.__embeddedChatConversations;
    delete globalThis.__embeddedChatSent;
  });
  const { render, latest, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);
  await React.act(async () => findBottomBar(latest()).props.onAskSubmit("And the deadline?"));
  const docked = findDockedChat(latest()).props;
  assert.equal(docked.messages, messages);
  assert.equal(docked.noteConversations, conversations);

  await React.act(async () => docked.actionChips.props.onRunAction(FOLLOW_UP));
  const [cta, options] = globalThis.__embeddedChatSent.at(-1);
  assert.equal(cta, "Follow-up", "the docked chat's own chip continues the open conversation");
  assert.ok(options.requestText.includes("Draft a follow-up."));
  await unmount();
});

test("a chat action from the collapsed picker opens the docked chat, with the actions and Generate summary", async (t) => {
  globalThis.__noteActions = [FOLLOW_UP];
  globalThis.__embeddedChatSent = [];
  t.after(() => {
    delete globalThis.__noteActions;
    delete globalThis.__embeddedChatSent;
  });
  const { render, latest, unmount } = await loadNoteEditor(t);
  const ran = [];

  await render(ENHANCEMENT, { onRunNoteAction: (action) => ran.push(action.client_id) });
  const bar = findBottomBar(latest());
  await React.act(async () => bar.props.actionPicker.props.onRunAction(FOLLOW_UP));

  const docked = findDockedChat(latest());
  assert.ok(docked, "the docked chat opens without the bar ever unfolding");
  const chips = docked.props.actionChips.props;
  assert.equal(chips.docked, true);
  assert.deepEqual(chips.actions, [FOLLOW_UP]);
  assert.equal(docked.props.slashCommands.length, 1, "and offers the same / menu");
  chips.generateSummary.run();
  assert.deepEqual(ran, [DEFAULT_TEMPLATE.client_id], "Generate summary runs the default template");
  const [[marker, shown, { requestText }]] = globalThis.__embeddedChatSent;
  assert.equal(marker, "new chat", "from the ask bar it starts a new conversation");
  assert.equal(shown, "Follow-up");
  assert.ok(requestText.includes("Draft a follow-up."));
  await unmount();
});

test("a summary action from the collapsed picker runs on the summary and leaves the chat closed", async (t) => {
  const shorten = {
    ...TEMPLATE,
    id: 4,
    client_id: "shorten",
    kind: "action",
    name: "Shorten",
    prompt: "Shorten it.",
    sections: null,
    output: "summary",
    translation_key: null,
  };
  globalThis.__noteActions = [shorten];
  globalThis.__embeddedChatSent = [];
  t.after(() => {
    delete globalThis.__noteActions;
    delete globalThis.__embeddedChatSent;
  });
  const { render, latest, unmount } = await loadNoteEditor(t);
  const ran = [];

  await render(ENHANCEMENT, { onRunNoteAction: (action) => ran.push(action.client_id) });
  const bar = findBottomBar(latest());
  await React.act(async () => bar.props.actionPicker.props.onRunAction(shorten));

  assert.deepEqual(ran, ["shorten"]);
  assert.equal(findDockedChat(latest()), null);
  assert.deepEqual(globalThis.__embeddedChatSent, []);
  await unmount();
});

test("a question sent while a reply is still coming waits as the docked chat's draft", async (t) => {
  globalThis.__embeddedChatAgentState = "streaming";
  globalThis.__embeddedChatSent = [];
  t.after(() => {
    delete globalThis.__embeddedChatAgentState;
    delete globalThis.__embeddedChatSent;
  });
  const { render, latest, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);
  await React.act(async () => findBottomBar(latest()).props.onAskSubmit("And the budget?"));
  assert.deepEqual(globalThis.__embeddedChatSent, []);
  assert.equal(findDockedChat(latest()).props.draftText, "And the budget?");
  await unmount();
});
