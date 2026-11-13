const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// Server rendering runs no effects and drops state updates, so most tests
// render the dialog once, capture the handlers its controls were given, and
// call them directly. Tests that need effects mount it on a fake DOM instead.
// Assertions are on what reaches the clipboard, the API, and the local DB,
// never on intermediate state.

const CLOUD_ID = "cloud-note-1";
const PREFIX = "ow_share_abc1234";
const TOKEN = `${PREFIX}${"x".repeat(25)}`;
const ROTATED_AWAY_TOKEN = `ow_share_zzz9999${"y".repeat(25)}`;
const NEW_PREFIX = "ow_share_new0000";
const NEW_TOKEN = `${NEW_PREFIX}${"n".repeat(25)}`;

const WORKSPACE_ID = "ws-1";
function space(id, kind, name, workspaceId) {
  return { id, kind, name, emoji: null, workspace_id: workspaceId, account_id: null, teams: [] };
}
const TEAM_SPACE = space(1, "team", "Design", WORKSPACE_ID);
const PRIVATE_SPACE = space(2, "private", "Personal", WORKSPACE_ID);
// Notes move into neither: one is linked to no workspace, the other is another workspace's.
const LEGACY_TEAM_SPACE = space(3, "team", "Old team", null);
const OTHER_WORKSPACE_TEAM_SPACE = space(4, "team", "Elsewhere", "ws-2");
const ALL_SPACES = [TEAM_SPACE, PRIVATE_SPACE, LEGACY_TEAM_SPACE, OTHER_WORKSPACE_TEAM_SPACE];

function shareSettings(visibility, tokenPrefix) {
  return {
    visibility,
    token_prefix: tokenPrefix,
    domain_allowlist: [],
    updated_by_user_id: null,
    updated_at: null,
  };
}

function accessGrant(id, overrides = {}) {
  return {
    id,
    principal: { type: "user", id: `${id}-user`, email: `${id}@acme.com`, name: null, image: null },
    permission: "viewer",
    source: "direct",
    inherited: false,
    pending: false,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

const MOCK_MODULES = {
  "react-i18next": `
    export const useTranslation = () => ({ t: (key) => key });
  `,
  "/hooks/useAuth": `
    export const useAuth = () => ({
      isSignedIn: globalThis.__shareTest.signedIn,
      user: { name: "Owner", email: "owner@acme.com" },
    });
  `,
  "/lib/authRequestContext": `export const getValidatedAuthGeneration = () => globalThis.__shareTest.generation;`,
  "/hooks/usePolicy": `export const usePolicySnapshot = () => ({});`,
  "/stores/policyRules": `
    export const filterShareVisibilityOptions = (options) => options;
    export const hasUsableExternalShareVisibility = () => !globalThis.__shareTest.sharingDenied;
    // The slice of the real rule these tests lean on: a private note has no
    // link, and a test can withdraw link sharing by policy.
    export const isShareActionAllowed = (_state, action, visibility) =>
      !(
        (action === "copy-link" || action === "rotate-link") &&
        (visibility === "private" || globalThis.__shareTest.linkDenied)
      );
  `,
  "/services/SyncService.js": `
    export const syncService = {
      async ensureNoteSynced(noteId) {
        globalThis.__shareTest.calls.push({ name: "ensureNoteSynced", args: [noteId] });
        const result = globalThis.__shareTest.ensureResult;
        return typeof result === "function" ? result() : result;
      },
    };
  `,
  "/hooks/useWorkspace": `
    export const useWorkspace = () => ({
      workspaces: globalThis.__shareTest.workspaces,
      loaded: globalThis.__shareTest.workspacesLoaded,
      defaultWorkspaceId: "${WORKSPACE_ID}",
    });
    export const useSpacesInWorkspaceScope = (spaces) => spaces;
  `,
  "/services/NoteSharingService.js": `
    const record = (name, ...args) => globalThis.__shareTest.calls.push({ name, args });
    const cached = (id) => globalThis.__shareTest.cache.get(id);
    export const NoteSharingService = {
      async getShareSettings(id) {
        record("getShareSettings", id);
        if (globalThis.__shareTest.refreshFails) throw new Error("offline");
        const entry = globalThis.__shareTest.server ?? cached(id);
        return { share: entry.share, invitations: entry.invitations, access: entry.access };
      },
      async updateShareSettings(id, visibility, domains) {
        record("updateShareSettings", id, visibility, domains);
        return globalThis.__shareTest.updateResult;
      },
      async rotateToken(id) {
        record("rotateToken", id);
        return globalThis.__shareTest.rotateResult;
      },
      async clearShare(id) {
        record("clearShare", id);
        if (globalThis.__shareTest.clearShareFails) throw new Error("offline");
        return { share: { ...cached(id).share, visibility: "private", token_prefix: null } };
      },
      async updateAccessGrant(id, grantId, permission) {
        record("updateAccessGrant", id, grantId, permission);
        return cached(id).access.grants.find((grant) => grant.id === grantId);
      },
      async removeAccessGrant(id, grantId) {
        record("removeAccessGrant", id, grantId);
        const server = globalThis.__shareTest.server;
        if (server?.access) {
          server.access = {
            ...server.access,
            grants: server.access.grants.filter((grant) => grant.id !== grantId),
          };
        }
      },
      async revokeInvite(id, invitationId) {
        record("revokeInvite", id, invitationId);
        const server = globalThis.__shareTest.server;
        if (server) {
          server.invitations = server.invitations.filter((invitation) => invitation.id !== invitationId);
        }
      },
      async searchAccessPrincipals() {
        return { suggestions: [] };
      },
    };
  `,
  "/stores/noteStore": `
    const cache = () => globalThis.__shareTest.cache;
    export const getShareCacheEntry = (id) => cache().get(id) ?? null;
    export const updateShareCache = (id, updater) => {
      const current = cache().get(id);
      cache().set(id, { ...current, ...updater(current) });
    };
    export const persistNoteShareState = async (noteId, updates) => {
      globalThis.__shareTest.persisted.push({ noteId, updates });
    };
    export const useSpaces = () => globalThis.__shareTest.spaces;
    export const useShareCacheEntry = (id) => (id ? (cache().get(id) ?? null) : null);
  `,
  "/ui/useToast": `
    export const useToast = () => ({ toast: (props) => globalThis.__shareTest.toasts.push(props) });
  `,
  "/ui/dialog": `
    import { createElement } from "react";
    const passthrough = (props) => createElement("div", null, props.children);
    export const Dialog = passthrough;
    export const DialogContent = passthrough;
    export const DialogTitle = passthrough;
    export const DialogDescription = passthrough;
    export const ConfirmDialog = (props) => {
      globalThis.__shareTest.confirmDialogs.push(props);
      return null;
    };
  `,
  "/ui/button": `
    import { createElement } from "react";
    export const Button = (props) => {
      globalThis.__shareTest.buttons.push(props);
      return createElement("button", null, props.children);
    };
  `,
  "/ui/dropdown-menu": `
    import { createElement } from "react";
    const passthrough = (props) => createElement("div", null, props.children);
    export const DropdownMenu = passthrough;
    export const DropdownMenuTrigger = passthrough;
    export const DropdownMenuContent = passthrough;
    export const DropdownMenuItem = (props) => {
      globalThis.__shareTest.menuItems.push(props);
      return createElement("div", null, props.children);
    };
  `,
  "/MemberAvatar": `export default function MemberAvatar() { return null; }`,
  "/ShareVisibilityMenu": `export default function ShareVisibilityMenu() { return null; }`,
};

// The dialog's handlers are fire-and-forget (`() => void handler()`), and every
// mocked call resolves in microtasks, so one macrotask turn settles them.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

async function setupDialog(
  t,
  {
    entry,
    server,
    updateResult = null,
    rotateResult = null,
    spaces = ALL_SPACES,
    ensureResult = null,
    moveResult = { success: true },
    signedIn = true,
    workspaces = [{ id: WORKSPACE_ID }],
    workspacesLoaded = true,
    sharingDenied = false,
    freshNote = null,
  }
) {
  const clipboardWrites = [];
  installBrowserGlobals(t, {
    window: {
      setTimeout: () => 1,
      clearTimeout: () => {},
      electronAPI: { getNote: async () => freshNote },
    },
  });
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => void clipboardWrites.push(text) },
  });
  const state = {
    generation: 1,
    cache: new Map([[CLOUD_ID, entry]]),
    calls: [],
    persisted: [],
    toasts: [],
    confirmDialogs: [],
    buttons: [],
    menuItems: [],
    server,
    updateResult,
    rotateResult,
    spaces,
    ensureResult,
    moveResult,
    signedIn,
    workspaces,
    workspacesLoaded,
    sharingDenied,
    closed: 0,
  };
  globalThis.__shareTest = state;
  t.after(() => {
    delete globalThis.__shareTest;
    delete globalThis.navigator.clipboard;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-share-note-dialog-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCK_MODULES,
  });
  const { default: ShareNoteDialog } = await vite.ssrLoadModule(
    "/components/notes/ShareNoteDialog.tsx"
  );
  const callsTo = (name) => state.calls.filter((call) => call.name === name);
  return { state, clipboardWrites, callsTo, ShareNoteDialog };
}

// A team note unless a test says otherwise: the note the link tests share.
function dialogProps(note, extra = {}) {
  const state = globalThis.__shareTest;
  return {
    open: true,
    onOpenChange: (open) => {
      if (!open) state.closed += 1;
    },
    note: {
      id: 7,
      cloud_id: CLOUD_ID,
      is_shared: 1,
      share_token: null,
      space_id: TEAM_SPACE.id,
      ...note,
    },
    canMoveNote: true,
    onMoveNote: async (noteId, target) => {
      state.calls.push({ name: "moveNote", args: [noteId, target] });
      return state.moveResult;
    },
    onOpenTeamspaces: () => state.calls.push({ name: "openTeamspaces", args: [] }),
    ...extra,
  };
}

async function renderDialog(t, { note, props = {}, ...options }) {
  const { state, clipboardWrites, callsTo, ShareNoteDialog } = await setupDialog(t, options);
  const markup = renderToStaticMarkup(createElement(ShareNoteDialog, dialogProps(note, props)));

  return {
    state,
    markup,
    linkButton: findLinkButton(state),
    clipboardWrites,
    callsTo,
  };
}

function findLinkButton(state) {
  return (
    state.buttons.findLast((props) =>
      /noteEditor\.share\.dialog\.(copyLink|createLink)/.test(textOf(props.children))
    ) ?? null
  );
}

function latestLinkButton(state) {
  const linkButton = findLinkButton(state);
  assert.ok(linkButton, "expected the link button to render");
  return linkButton;
}

// Mounts the dialog so its effects run. `setOpen` re-renders it open or closed,
// as NoteEditor does; `copyLinkOnOpen` is the Share button's link segment;
// `setNote` re-renders it with the note as the store now has it.
async function mountDialog(t, { note, copyLinkOnOpen = false, props = {}, ...options }) {
  let root = null;
  // Registered first: after-hooks run in order, and unmounting needs the globals.
  t.after(() => act(() => root?.unmount()));
  const dialog = await setupDialog(t, options);
  root = createRoot(installHostDom(t));
  let current = { note, open: true };
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(
          dialog.ShareNoteDialog,
          dialogProps(current.note, { ...props, open: current.open, copyLinkOnOpen })
        )
      );
    });
    await act(settle);
  };
  const setOpen = async (open) => {
    current = { ...current, open };
    await render();
  };
  const setNote = async (next) => {
    current = { ...current, note: next };
    await render();
  };
  await render();
  return { ...dialog, setOpen, setNote };
}

test("an invite-only note copies the invitation link and never rotates", async (t) => {
  const { linkButton, clipboardWrites, callsTo } = await renderDialog(t, {
    note: { share_token: null },
    entry: { share: shareSettings("invited", PREFIX), invitations: [], rawToken: null },
  });

  linkButton.onClick();
  await settle();

  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/invite/${PREFIX}`]);
  assert.equal(callsTo("rotateToken").length, 0);
});

test("a link share with no local token does not rotate until the replacement is confirmed", async (t) => {
  const { state, linkButton, clipboardWrites, callsTo } = await renderDialog(t, {
    note: { share_token: null },
    entry: { share: shareSettings("link", PREFIX), invitations: [], rawToken: null },
    rotateResult: { share: shareSettings("link", NEW_PREFIX), raw_token: NEW_TOKEN },
  });

  linkButton.onClick();
  await settle();

  assert.equal(callsTo("rotateToken").length, 0, "the click alone must not rotate");
  assert.deepEqual(clipboardWrites, []);

  const confirm = state.confirmDialogs.find(
    (props) => props.title === "noteEditor.share.dialog.replaceLink.title"
  );
  assert.ok(confirm, "expected a replace-link confirmation");
  assert.equal(confirm.description, "noteEditor.share.dialog.replaceLink.description");
  assert.equal(confirm.confirmText, "noteEditor.share.dialog.replaceLink.confirm");
  assert.equal(confirm.cancelText, "common.cancel");

  confirm.onConfirm();
  await settle();

  assert.equal(callsTo("rotateToken").length, 1);
  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/n/${NEW_TOKEN}`]);
  assert.deepEqual(state.persisted.at(-1), {
    noteId: 7,
    updates: { is_shared: 1, share_token: NEW_TOKEN },
  });
});

test("a stored token rotated away on another device is never copied", async (t) => {
  const { linkButton, clipboardWrites, callsTo } = await renderDialog(t, {
    note: { share_token: ROTATED_AWAY_TOKEN },
    entry: {
      share: shareSettings("link", PREFIX),
      invitations: [],
      rawToken: ROTATED_AWAY_TOKEN,
    },
  });

  linkButton.onClick();
  await settle();

  assert.deepEqual(clipboardWrites, []);
  assert.equal(callsTo("rotateToken").length, 0);
});

test("a current stored token is copied as the viewer link", async (t) => {
  const { linkButton, clipboardWrites, callsTo } = await renderDialog(t, {
    note: { share_token: TOKEN },
    entry: { share: shareSettings("link", PREFIX), invitations: [], rawToken: null },
  });

  linkButton.onClick();
  await settle();

  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/n/${TOKEN}`]);
  assert.equal(callsTo("rotateToken").length, 0);
});

test("creating a link on a private note copies the token the server just minted", async (t) => {
  const { linkButton, clipboardWrites, callsTo } = await renderDialog(t, {
    note: { is_shared: 0, share_token: ROTATED_AWAY_TOKEN },
    entry: { share: shareSettings("private", null), invitations: [], rawToken: null },
    updateResult: { share: shareSettings("link", PREFIX), raw_token: TOKEN },
  });

  linkButton.onClick();
  await settle();

  assert.equal(callsTo("updateShareSettings").length, 1);
  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/n/${TOKEN}`]);
  assert.equal(callsTo("rotateToken").length, 0);
});

test("an invite-only note with no prefix yet rotates without asking and copies the invitation link", async (t) => {
  const { state, linkButton, clipboardWrites, callsTo } = await renderDialog(t, {
    entry: { share: shareSettings("invited", null), invitations: [], rawToken: null },
    rotateResult: { share: shareSettings("invited", NEW_PREFIX), raw_token: NEW_TOKEN },
  });

  linkButton.onClick();
  await settle();

  assert.equal(callsTo("rotateToken").length, 1);
  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/invite/${NEW_PREFIX}`]);
  assert.equal(state.toasts.length, 0);
});

test("creating a link that returns no token rotates once the share is off private", async (t) => {
  const { linkButton, clipboardWrites, callsTo } = await renderDialog(t, {
    note: { is_shared: 0 },
    entry: { share: shareSettings("private", null), invitations: [], rawToken: null },
    updateResult: { share: shareSettings("link", null), raw_token: null },
    rotateResult: { share: shareSettings("link", NEW_PREFIX), raw_token: NEW_TOKEN },
  });

  linkButton.onClick();
  await settle();

  assert.equal(callsTo("rotateToken").length, 1);
  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/n/${NEW_TOKEN}`]);
});

test("confirming the replacement copies instead when a refresh made the note invite-only", async (t) => {
  const { state, linkButton, clipboardWrites, callsTo } = await renderDialog(t, {
    entry: { share: shareSettings("link", PREFIX), invitations: [], rawToken: null },
    rotateResult: { share: shareSettings("link", NEW_PREFIX), raw_token: NEW_TOKEN },
  });
  linkButton.onClick();
  await settle();

  // The dialog's load refresh lands while the confirm is open.
  state.cache.get(CLOUD_ID).share = shareSettings("invited", PREFIX);
  state.confirmDialogs[0].onConfirm();
  await settle();

  assert.equal(callsTo("rotateToken").length, 0);
  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/invite/${PREFIX}`]);
});

test("confirming the replacement after the note went private says the copy failed", async (t) => {
  const { state, linkButton, clipboardWrites, callsTo } = await renderDialog(t, {
    entry: { share: shareSettings("link", PREFIX), invitations: [], rawToken: null },
    rotateResult: { share: shareSettings("link", NEW_PREFIX), raw_token: NEW_TOKEN },
  });
  linkButton.onClick();
  await settle();

  state.cache.get(CLOUD_ID).share = shareSettings("private", null);
  state.confirmDialogs[0].onConfirm();
  await settle();

  assert.equal(callsTo("rotateToken").length, 0);
  assert.deepEqual(clipboardWrites, []);
  assert.deepEqual(
    state.toasts.map((toast) => toast.title),
    ["noteEditor.share.dialog.error.copyFailed"]
  );
});

test("confirming the replacement after policy withdrew link sharing does not rotate", async (t) => {
  const { state, linkButton, clipboardWrites, callsTo } = await renderDialog(t, {
    entry: { share: shareSettings("link", PREFIX), invitations: [], rawToken: null },
    rotateResult: { share: shareSettings("link", NEW_PREFIX), raw_token: NEW_TOKEN },
  });
  linkButton.onClick();
  await settle();

  state.linkDenied = true;
  state.confirmDialogs[0].onConfirm();
  await settle();

  assert.equal(callsTo("rotateToken").length, 0);
  assert.deepEqual(clipboardWrites, []);
  assert.deepEqual(
    state.toasts.map((toast) => toast.title),
    ["noteEditor.share.dialog.error.copyFailed"]
  );
});

test("copy on open waits for the refreshed share instead of the cached one", async (t) => {
  // Cached when the note opened: a link share whose token was since rotated
  // away on another device, and the note has since become invite-only.
  const { state, clipboardWrites, callsTo } = await mountDialog(t, {
    copyLinkOnOpen: true,
    note: { share_token: ROTATED_AWAY_TOKEN },
    entry: {
      share: shareSettings("link", ROTATED_AWAY_TOKEN.slice(0, 16)),
      invitations: [],
      rawToken: ROTATED_AWAY_TOKEN,
    },
    server: { share: shareSettings("invited", PREFIX), invitations: [] },
  });

  assert.equal(callsTo("getShareSettings").length, 1);
  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/invite/${PREFIX}`]);
  assert.equal(callsTo("rotateToken").length, 0);
  assert.equal(state.cache.get(CLOUD_ID).rawToken, null, "the stale token leaves the cache");
});

test("reopening from the link segment waits for a new refresh too", async (t) => {
  const { state, clipboardWrites, setOpen } = await mountDialog(t, {
    copyLinkOnOpen: true,
    entry: { share: shareSettings("link", PREFIX), invitations: [], rawToken: TOKEN },
  });
  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/n/${TOKEN}`]);

  await setOpen(false);
  // Meanwhile the note becomes invite-only on another device.
  state.server = { share: shareSettings("invited", NEW_PREFIX), invitations: [] };
  await setOpen(true);

  assert.deepEqual(clipboardWrites, [
    `https://notes.openwhispr.com/n/${TOKEN}`,
    `https://notes.openwhispr.com/invite/${NEW_PREFIX}`,
  ]);
});

test("the replace confirm opens from the link button and closes with the dialog", async (t) => {
  const { state, callsTo, setOpen } = await mountDialog(t, {
    entry: { share: shareSettings("link", PREFIX), invitations: [], rawToken: null },
  });
  const confirmOpen = () =>
    state.confirmDialogs.findLast(
      (props) => props.title === "noteEditor.share.dialog.replaceLink.title"
    ).open;
  assert.equal(confirmOpen(), false);

  await act(async () => latestLinkButton(state).onClick());
  await act(settle);
  assert.equal(confirmOpen(), true);
  assert.equal(callsTo("rotateToken").length, 0);

  await setOpen(false);
  await setOpen(true);
  assert.equal(confirmOpen(), false);
});

test("a second confirm click while the replacement runs does not rotate again", async (t) => {
  const { state, clipboardWrites, callsTo } = await mountDialog(t, {
    entry: { share: shareSettings("link", PREFIX), invitations: [], rawToken: null },
  });
  let finishRotate;
  state.rotateResult = new Promise((resolve) => {
    finishRotate = () =>
      resolve({ share: shareSettings("link", NEW_PREFIX), raw_token: NEW_TOKEN });
  });
  const latestConfirm = () =>
    state.confirmDialogs.findLast(
      (props) => props.title === "noteEditor.share.dialog.replaceLink.title"
    );
  await act(async () => latestLinkButton(state).onClick());
  await act(settle);

  await act(async () => latestConfirm().onConfirm());
  await act(async () => latestConfirm().onConfirm());
  await act(async () => finishRotate());
  await act(settle);

  assert.equal(callsTo("rotateToken").length, 1);
  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/n/${NEW_TOKEN}`]);
});

test("synthetic scope rows offer no permission or remove controls", async (t) => {
  const direct = accessGrant("grant-direct", { permission: "viewer" });
  const scope = accessGrant("scope:workspace:w1", {
    principal: {
      type: "workspace",
      id: "w1",
      email: null,
      name: "Acme",
      image: null,
      member_count: 4,
    },
    source: "workspace",
    inherited: true,
  });
  const { state, callsTo } = await renderDialog(t, {
    entry: {
      share: shareSettings("invited", PREFIX),
      invitations: [],
      rawToken: null,
      access: {
        owner: { type: "user", id: "owner", email: "owner@acme.com", name: null, image: null },
        grants: [direct, scope],
        my_permission: "owner",
        can_manage_access: true,
        can_manage_inherited_access: true,
      },
    },
  });

  for (const item of state.menuItems.filter((props) => !props.disabled)) {
    item.onClick?.();
  }
  await settle();

  const targeted = [...callsTo("updateAccessGrant"), ...callsTo("removeAccessGrant")].map(
    (call) => call.args[1]
  );
  assert.ok(targeted.includes(direct.id), "the direct grant keeps its controls");
  assert.ok(!targeted.includes(scope.id), `scope row was offered controls: ${targeted}`);
});

const PRIVATE_NOTE = {
  space_id: PRIVATE_SPACE.id,
  cloud_id: null,
  is_shared: 0,
  client_note_id: "private-key",
};

function syncButton(state) {
  return state.buttons.findLast(
    (props) => textOf(props.children) === "noteEditor.share.dialog.syncAndShare"
  );
}

async function clickSync(state) {
  const button = syncButton(state);
  assert.ok(button, "expected explicit sync consent");
  assert.equal(button.disabled, false);
  await act(async () => button.onClick());
  await act(settle);
}

test("a local Private note waits for explicit sync consent and stays in Private", async (t) => {
  const { state, callsTo } = await mountDialog(t, {
    note: PRIVATE_NOTE,
    ensureResult: CLOUD_ID,
    server: { share: shareSettings("private", null), invitations: [] },
  });
  assert.deepEqual(state.calls, []);
  assert.ok(syncButton(state));
  assert.equal(findLinkButton(state), null);
  await clickSync(state);
  assert.deepEqual(
    state.calls.map((call) => call.name),
    ["ensureNoteSynced", "getShareSettings"]
  );
  assert.deepEqual(callsTo("ensureNoteSynced")[0].args, [7]);
  assert.ok(findLinkButton(state));
  assert.equal(callsTo("moveNote").length, 0);
});

test("a backed-up Private note shares its existing identity without moving or another upload", async (t) => {
  const { state, clipboardWrites, callsTo } = await mountDialog(t, {
    copyLinkOnOpen: true,
    note: { ...PRIVATE_NOTE, cloud_id: CLOUD_ID },
    entry: { share: shareSettings("link", PREFIX), invitations: [], rawToken: TOKEN },
  });
  assert.deepEqual(callsTo("getShareSettings")[0].args, [CLOUD_ID]);
  assert.equal(callsTo("ensureNoteSynced").length, 0);
  assert.equal(callsTo("moveNote").length, 0);
  assert.deepEqual(clipboardWrites, [`https://notes.openwhispr.com/n/${TOKEN}`]);
  assert.deepEqual(state.persisted, [{ noteId: 7, updates: { is_shared: 1 } }]);
});

test("a background-synced Private note uses its current DB identity", async (t) => {
  const { callsTo } = await mountDialog(t, {
    note: PRIVATE_NOTE,
    freshNote: { id: 7, ...PRIVATE_NOTE, cloud_id: CLOUD_ID },
    entry: { share: shareSettings("private", null), invitations: [], rawToken: null },
  });
  assert.equal(callsTo("ensureNoteSynced").length, 0);
  assert.deepEqual(callsTo("getShareSettings")[0].args, [CLOUD_ID]);
});

test("a stale DB identity is not adopted for a forked Private note", async (t) => {
  const { state } = await mountDialog(t, {
    note: PRIVATE_NOTE,
    freshNote: { id: 7, ...PRIVATE_NOTE, client_note_id: "old-key", cloud_id: "old-cloud" },
  });
  assert.deepEqual(state.calls, []);
  assert.ok(syncButton(state));
});

test("sharing policy blocks the upload consent action", async (t) => {
  const { state, markup } = await renderDialog(t, { note: PRIVATE_NOTE, sharingDenied: true });
  assert.match(markup, /common.managedByOrg/);
  assert.equal(syncButton(state), undefined);
  assert.deepEqual(state.calls, []);
});

test("signed-out notes cannot start a share upload", async (t) => {
  const { state } = await renderDialog(t, { note: PRIVATE_NOTE, signedIn: false });
  assert.equal(syncButton(state).disabled, true);
  await syncButton(state).onClick();
  assert.deepEqual(state.calls, []);
});

test("a failed consented upload keeps the sync action available", async (t) => {
  t.mock.method(console, "error", () => {});
  const { state } = await mountDialog(t, { note: PRIVATE_NOTE, ensureResult: null });
  await clickSync(state);
  assert.equal(findLinkButton(state), null);
  assert.equal(syncButton(state).disabled, false);
  assert.equal(state.toasts.at(-1).title, "noteEditor.share.dialog.error.syncFailed");
});

test("a synced identity is not reused after a Private note forks", async (t) => {
  const { state, setNote, callsTo } = await mountDialog(t, {
    note: PRIVATE_NOTE,
    ensureResult: CLOUD_ID,
    server: { share: shareSettings("private", null), invitations: [] },
  });
  await clickSync(state);
  state.buttons.length = 0;
  await setNote({ ...PRIVATE_NOTE, client_note_id: "new-key" });
  assert.ok(syncButton(state));
  assert.equal(findLinkButton(state), null);
  assert.equal(callsTo("getShareSettings").length, 1);
});

for (const change of ["close", "reopen", "fork", "sign-in replacement"]) {
  test(`an upload completing after ${change} does not open sharing`, async (t) => {
    let resolve;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const { state, setOpen, setNote, callsTo } = await mountDialog(t, {
      note: PRIVATE_NOTE,
      ensureResult: () => pending,
      server: { share: shareSettings("private", null), invitations: [] },
    });
    await act(async () => syncButton(state).onClick());
    if (change === "close") await setOpen(false);
    else if (change === "reopen") {
      await setOpen(false);
      await setOpen(true);
    } else if (change === "sign-in replacement") state.generation++;
    else await setNote({ ...PRIVATE_NOTE, client_note_id: "new-key" });
    await act(async () => resolve(CLOUD_ID));
    await act(settle);
    assert.equal(callsTo("getShareSettings").length, 0);
  });
}

test("removing a Private note's last guest preserves the existing share and link", async (t) => {
  const grant = accessGrant("last-guest");
  const server = {
    share: shareSettings("invited", PREFIX),
    invitations: [],
    access: {
      owner: { type: "user", id: "owner", email: "owner@acme.com" },
      grants: [grant],
      my_permission: "owner",
      can_manage_access: true,
      can_manage_inherited_access: true,
    },
  };
  const { state, callsTo } = await mountDialog(t, {
    note: { ...PRIVATE_NOTE, cloud_id: CLOUD_ID, is_shared: 1 },
    entry: { ...server, rawToken: null },
    server,
  });
  const remove = state.menuItems.findLast(
    (props) => textOf(props.children) === "noteEditor.share.dialog.revoke"
  );
  await act(async () => remove.onClick());
  await act(settle);
  assert.equal(callsTo("removeAccessGrant").length, 1);
  assert.equal(callsTo("clearShare").length, 0);
  assert.deepEqual(state.persisted, []);
  assert.ok(!state.confirmDialogs.some((dialog) => dialog.open));
});

test("a team note still uploads automatically when its dialog opens", async (t) => {
  const { state } = await mountDialog(t, {
    note: { cloud_id: null, is_shared: 0 },
    ensureResult: CLOUD_ID,
    server: { share: shareSettings("private", null), invitations: [] },
  });
  assert.deepEqual(
    state.calls.map((call) => call.name),
    ["ensureNoteSynced", "getShareSettings"]
  );
});

for (const change of ["fork", "sign-in replacement"]) {
  test(`a link mutation receipt after ${change} does not persist or copy the old share`, async (t) => {
    let resolve;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const { state, setNote, clipboardWrites } = await mountDialog(t, {
      note: { ...PRIVATE_NOTE, cloud_id: CLOUD_ID },
      entry: { share: shareSettings("private", null), invitations: [], rawToken: null },
      updateResult: pending,
    });
    await act(async () => findLinkButton(state).onClick());
    if (change === "fork") await setNote({ ...PRIVATE_NOTE, client_note_id: "fork-key" });
    else state.generation++;
    await act(async () => resolve({ share: shareSettings("link", PREFIX), raw_token: TOKEN }));
    await act(settle);
    assert.deepEqual(state.persisted, []);
    assert.deepEqual(clipboardWrites, []);
  });
}

test("revoking the last Private invitation preserves its visibility and reusable link", async (t) => {
  const invitation = {
    id: "inv-1",
    email: "guest@acme.com",
    permission: "viewer",
    accepted_at: null,
    created_at: "2026-09-01T00:00:00Z",
  };
  const server = { share: shareSettings("invited", PREFIX), invitations: [invitation] };
  const { state, callsTo } = await mountDialog(t, {
    note: { ...PRIVATE_NOTE, cloud_id: CLOUD_ID, is_shared: 1 },
    entry: { ...server, rawToken: null },
    server,
  });
  const remove = state.menuItems.findLast(
    (props) => textOf(props.children) === "noteEditor.share.dialog.revoke"
  );
  await act(async () => remove.onClick());
  await act(settle);
  assert.equal(callsTo("revokeInvite").length, 1);
  assert.equal(callsTo("clearShare").length, 0);
  assert.deepEqual(state.persisted, []);
});
