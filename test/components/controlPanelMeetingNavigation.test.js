const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// The real ControlPanel, so its wiring (main's pending navigation to the recording
// request, the New chat menu) is what's under test; everything it renders around that is a stub.
const NULL_COMPONENT = "export default () => null;";
const MOCKS = {
  "./notes/PersonalNotesView": `
    export default function PersonalNotesView(props) {
      globalThis.__notesProps = props;
      return null;
    }`,
  "/hooks/useCreateNote": `
    export const useCreateNote = (canAutoStart) => {
      globalThis.__createNoteCheck = canAutoStart;
      return { createNote() {}, createNoteIn() {} };
    };
    export const startRecordingForNote = async (note, _recorderName, startSource, canAutoStart) => {
      if (canAutoStart && !canAutoStart()) return false;
      globalThis.__starts.push([note.id, startSource]);
      return true;
    };`,
  "/ui/useToast": `
    const toast = () => "1";
    export const useToast = () => ({ toast, dismiss() {} });
  `,
  "/useAuth": `
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, user: null });`,
  "/hooks/useSignOut": "export const useSignOut = () => ({ signOut() {} });",
  "/hooks/useHotkey": `export const useHotkey = () => ({ hotkey: "F8" });`,
  "/hooks/useUpdater": `
    export const useUpdater = () => ({
      status: {},
      info: null,
      downloadProgress: 0,
      isChecking: false,
      isDownloading: false,
      isInstalling: false,
      check() {},
      download() {},
      install() {},
    });`,
  "/hooks/useSettings": `
    export const useSettings = () => new Proxy({}, { get: () => undefined });
  `,
  "/hooks/useUsage": "export const useUsage = () => null;",
  "/hooks/useJoinableWorkspaces":
    "export const useJoinableWorkspaces = () => ({ workspaces: [] });",
  "/hooks/useGpuBannerAvailability": "export const useGpuBannerAvailability = () => false;",
  "/hooks/useSignInCloudNudge": "export const useSignInCloudNudge = () => {};",
  "/services/SyncService.js":
    "export const syncService = { setNoteOpen() {}, start() {}, stop() {} };",
  "./UpgradePrompt": NULL_COMPONENT,
  "./PostMigrationOnboarding": NULL_COMPONENT,
  "./RequiredModelsBanner": "export const RequiredModelsBanner = () => null;",
  "./ControlPanelSidebar": NULL_COMPONENT,
  "./ControlPanelTopBar": "export default (props) => props.actions ?? null;",
  "./HistoryView": NULL_COMPONENT,
  "./MeetingRecordingMount": NULL_COMPONENT,
  "./notes/MeetingRecordingPill": NULL_COMPONENT,
  "./notes/NewNoteMenu": `
    export default function NewNoteMenu(props) {
      globalThis.__newNoteMenu = props;
      return null;
    }`,
  "./chat/ChatView": NULL_COMPONENT,
  "./ProfileMenu": NULL_COMPONENT,
  "./notes/BackgroundActionToastListener": NULL_COMPONENT,
  "./notes/AssistantNoteUndoListener": NULL_COMPONENT,
  "./notes/SpaceSyncToastListener": NULL_COMPONENT,
  "./SharedDictionaryArrivalToastListener": NULL_COMPONENT,
  "./AcceptInvitationModal": NULL_COMPONENT,
  "./JoinYourTeamModal": NULL_COMPONENT,
};

const NOTE = { id: 9, space_id: 1, folder_id: null, title: "Standup", note_type: "meeting" };

function electronApi(navigation, calls) {
  const known = {
    getPlatform: () => "darwin",
    getPendingMeetingNoteNavigation: async () => navigation,
    confirmMeetingNoteNavigation: async () => ({ success: true, value: NOTE }),
    meetingNoteOpenedWithoutRecording: async (id) => calls.noteOnly.push(id),
    meetingNoteClosed: async (id) => calls.closed.push(id),
    restoreFromMeetingMode: async () => calls.restore.push(true),
    getSpaces: async () => [{ id: 1, kind: "private" }],
    getFolders: async () => [],
    getFolderNoteCounts: async () => [],
    getNotes: async () => [],
    getContainerNotes: async () => [],
    getTranscriptions: async () => [],
  };
  return new Proxy(known, {
    get: (target, name) =>
      target[name] ?? (String(name).startsWith("on") ? () => () => {} : async () => undefined),
  });
}

async function mount(t, navigation, transcriptionStart, features = {}) {
  let root;
  const unmount = async () => {
    const mounted = root;
    root = null;
    await React.act(async () => mounted.unmount());
  };
  t.after(async () => {
    if (root) await unmount();
    delete globalThis.__notesProps;
    delete globalThis.__starts;
    delete globalThis.__createNoteCheck;
    delete globalThis.__newNoteMenu;
  });
  const calls = { noteOnly: [], restore: [], closed: [], unmount, vite: null };
  globalThis.__starts = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: electronApi(navigation, calls),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "control-panel-meeting-navigation-",
    mockModules: MOCKS,
  });
  calls.vite = vite;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.11.1",
    policy: {
      version: 1,
      transcription: { allowedModes: ["openwhispr", "local"], allowedByokProviders: [] },
      llm: { allowedModes: ["openwhispr"], allowedByokProviders: [] },
      features,
      meetings: { transcriptionStart },
      sharing: { externalLinkSharing: "allowed" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: true,
      },
      minAppVersion: null,
    },
  });
  const { default: ControlPanel } = await vite.ssrLoadModule("/components/ControlPanel.tsx");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(ControlPanel)));
  return calls;
}

// The drain loads the lazy editor and confirms the note over IPC before it settles.
async function until(condition) {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  assert.ok(condition(), "timed out waiting for the meeting navigation to settle");
}

const NOTIFICATION = {
  navigationId: "nav",
  noteSessionId: "session",
  noteId: 9,
  spaceId: 1,
  folderId: null,
};

test("a meeting prompt records under automatic policy", async (t) => {
  const calls = await mount(t, NOTIFICATION, "automatic");
  await until(() => globalThis.__starts.length > 0);
  assert.deepEqual(globalThis.__starts, [[9, "prompt"]]);
  assert.equal(globalThis.__createNoteCheck(), true, "New note follows the policy too");
  assert.deepEqual(calls.noteOnly, []);
});

test("a meeting prompt only opens the note under manual policy", async (t) => {
  const calls = await mount(t, NOTIFICATION, "manual");
  await until(() => calls.noteOnly.length > 0);
  assert.deepEqual(globalThis.__starts, []);
  assert.deepEqual(calls.noteOnly, ["session"]);
  assert.deepEqual(calls.restore, [], "suppression leaves the layout alone");
  assert.equal(globalThis.__createNoteCheck(), false, "New note follows the policy too");
});

test("a pending navigation hands its trigger and session to the notes view", async (t) => {
  await mount(
    t,
    { noteId: 9, folderId: null, event: null, trigger: "hotkey", noteSessionId: "session" },
    "manual"
  );
  await until(() => globalThis.__notesProps?.meetingRecordingRequest);
  const request = globalThis.__notesProps.meetingRecordingRequest;
  assert.equal(request.trigger, "hotkey");
  assert.equal(request.noteSessionId, "session");
  assert.equal(globalThis.__notesProps.canAutoStartMeeting, globalThis.__createNoteCheck);
});

test("a navigation the panel unmounted before reading closes its session", async (t) => {
  const pending = Promise.withResolvers();
  const calls = await mount(t, pending.promise, "manual");
  await calls.unmount();
  pending.resolve({
    noteId: 9,
    folderId: null,
    event: null,
    trigger: "calendar-join",
    noteSessionId: "session",
  });
  await new Promise(setImmediate);
  assert.deepEqual(calls.closed, ["session"], "main already gave this navigation away");
});

test("New chat from the menu opens a new chat, not the conversation Chat had open", async (t) => {
  const { vite } = await mount(t, null, "automatic", { agentEnabled: true });
  const { useChatTurnStore, selectChat } = await vite.ssrLoadModule("/stores/chatTurnStore.ts");
  selectChat({ kind: "conversation", conversationId: 7 });
  await React.act(async () => globalThis.__newNoteMenu.onNewChat());
  assert.deepEqual(useChatTurnStore.getState().selection, { kind: "new-chat" });
});
