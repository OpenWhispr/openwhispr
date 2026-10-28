const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// The workspace intro must wait while another modal that opens on its own is up (the notes
// structure intro after an accepted invitation, Join your team, Tone & Style, migration),
// and show once that modal closes.

const DIALOG_MOCK = `
  const Empty = () => null;
  export const Dialog = Empty;
  export const DialogContent = Empty;
  export const DialogHeader = Empty;
  export const DialogFooter = Empty;
  export const DialogTitle = Empty;
  export const DialogDescription = Empty;
`;

const MOCKS = {
  "react-i18next": `
    export function useTranslation() {
      return { t: (key) => key };
    }
  `,
  "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: true });`,
  "/hooks/useWorkspace": `
    export const useWorkspace = () => ({
      workspaces: [{ id: "acme", name: "Acme Studio", role: "owner" }],
      setActive() {},
      refresh: async () => {},
    });
  `,
  "/stores/workspaceStore": `
    const read = () => ({
      activeWorkspaceId: "acme",
      loaded: true,
      loading: false,
      error: false,
      workspaces: [{ id: "acme", name: "Acme Studio", role: "owner" }],
    });
    export const useWorkspaceStore = Object.assign((selector) => selector(read()), {
      getState: read,
    });
  `,
  "/services/WorkspacesService": `
    export const WorkspacesService = {
      listMembers: async () => [],
      listJoinable: () => globalThis.__listJoinable(),
    };
  `,
  "/services/membershipActions": `export async function afterWorkspaceJoined() {}`,
  "/CreateWorkspaceDialog": `export default function CreateWorkspaceDialog() { return null; }`,
  "/stores/policyStore": `
    export const usePolicyStore = (selector) => selector({ accountId: "user-1" });
  `,
  "/stores/settingsStore": `
    import { DEFAULT_TONE_STYLES } from "/config/toneStyle";
    const read = () => ({ useCleanupModel: true, toneStyles: DEFAULT_TONE_STYLES });
    export const useSettingsStore = Object.assign((selector) => selector(read()), {
      getState: read,
    });
    export const getEffectiveCleanupModel = () => null;
    export const isCloudCleanupMode = () => true;
  `,
  "/workspace/WorkspaceIntroDialog": `
    export function WorkspaceIntroDialog({ open }) {
      globalThis.__intro = { open };
      return null;
    }
  `,
  "/ui/dropdown-menu": `
    const Empty = () => null;
    export const DropdownMenu = Empty;
    export const DropdownMenuTrigger = Empty;
    export const DropdownMenuContent = Empty;
    export const DropdownMenuItem = Empty;
    export const DropdownMenuSeparator = Empty;
  `,
  "/ui/dialog": DIALOG_MOCK,
  "/ui/useToast": `export const useToast = () => ({ toast() {} });`,
  "/ui/PermissionsSection": `export default function PermissionsSection() { return null; }`,
  "/hooks/usePermissions": `export const usePermissions = () => ({ micPermissionGranted: true });`,
  "/hooks/useSystemAudioPermission": `export const useSystemAudioPermission = () => ({});`,
};

async function setup(t) {
  // Registered first: teardowns run in order, and unmounting needs the globals still in place.
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  globalThis.__intro = null;
  t.after(() => {
    delete globalThis.__intro;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-intro-gate-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const load = async (path) => (await vite.ssrLoadModule(path)).default;
  const WorkspaceSwitcher = await load("/components/WorkspaceSwitcher.tsx");
  const modals = {
    structureIntro: await load("/components/notes/NotesStructureIntroDialog.tsx"),
    joinYourTeam: await load("/components/JoinYourTeamModal.tsx"),
    postMigration: await load("/components/PostMigrationOnboarding.tsx"),
    toneStyle: await load("/components/toneStyle/ToneStyleSetupDialog.tsx"),
  };
  const { useModalGateStore, useModalGate } = await vite.ssrLoadModule("/stores/modalGateStore.ts");
  const { useJoinableWorkspaces } = await vite.ssrLoadModule("/hooks/useJoinableWorkspaces.ts");
  // Wired as ControlPanel wires it: the check holds the gate until it answers.
  modals.joinCheck = function JoinCheck() {
    const { joinable, pending } = useJoinableWorkspaces("user-1", true);
    useModalGate("joinYourTeamPending", pending);
    return React.createElement(modals.joinYourTeam, {
      joinable,
      domain: "acme.com",
      onDismiss() {},
      onRequested() {},
    });
  };

  root = createRoot(container);
  const render = async (modal) =>
    React.act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          modal,
          React.createElement(WorkspaceSwitcher, { introAllowed: true })
        )
      )
    );
  return { modals, render, useModalGateStore };
}

const JOINABLE = [
  {
    source: "domain",
    mode: "join",
    request_state: "none",
    workspace_id: "beta",
    workspace_name: "Beta",
    member_count: 0,
    members: [],
  },
];

for (const [name, open, closed] of [
  [
    "the notes structure intro",
    (m) => React.createElement(m.structureIntro, { open: true, onOpenChange() {} }),
    (m) => React.createElement(m.structureIntro, { open: false, onOpenChange() {} }),
  ],
  [
    "Join your team",
    (m) =>
      React.createElement(m.joinYourTeam, {
        joinable: JOINABLE,
        domain: "acme.com",
        onDismiss() {},
        onRequested() {},
      }),
    (m) =>
      React.createElement(m.joinYourTeam, {
        joinable: [],
        domain: "acme.com",
        onDismiss() {},
        onRequested() {},
      }),
  ],
  [
    "the post-migration permissions",
    (m) => React.createElement(m.postMigration, { open: true, onOpenChange() {}, onDone() {} }),
    (m) => React.createElement(m.postMigration, { open: false, onOpenChange() {}, onDone() {} }),
  ],
  [
    "Tone & Style setup",
    (m) => React.createElement(m.toneStyle, { open: true, onOpenChange() {}, onOpenSettings() {} }),
    (m) => React.createElement(m.toneStyle, { open: false, onOpenChange() {}, onOpenSettings() {} }),
  ],
]) {
  test(`the workspace intro waits while ${name} is open`, async (t) => {
    const { modals, render, useModalGateStore } = await setup(t);

    await render(open(modals));
    assert.equal(globalThis.__intro.open, false);

    await render(closed(modals));
    assert.equal(globalThis.__intro.open, true);
    assert.deepEqual(useModalGateStore.getState().open, {});
  });
}

for (const [answer, introOpen] of [
  ["nothing to join", true],
  ["a workspace to join", false],
]) {
  test(`the workspace intro waits for the Join your team check (${answer})`, async (t) => {
    let respond;
    globalThis.__listJoinable = () => new Promise((resolve) => (respond = resolve));
    t.after(() => {
      delete globalThis.__listJoinable;
    });
    const { modals, render } = await setup(t);

    await render(React.createElement(modals.joinCheck));
    assert.equal(globalThis.__intro.open, false);

    await React.act(async () => respond(introOpen ? [] : JOINABLE));
    assert.equal(globalThis.__intro.open, introOpen);
  });
}

test("unmounting an open gated modal releases the gate", async (t) => {
  const { modals, render, useModalGateStore } = await setup(t);

  await render(React.createElement(modals.structureIntro, { open: true, onOpenChange() {} }));
  assert.equal(globalThis.__intro.open, false);

  await render(null);
  assert.equal(globalThis.__intro.open, true);
  assert.deepEqual(useModalGateStore.getState().open, {});
});
