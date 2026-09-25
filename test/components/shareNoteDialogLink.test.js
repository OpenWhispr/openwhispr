const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Server rendering runs no effects and drops state updates, so these tests
// render the dialog once, capture the handlers its controls were given, and
// call them directly. Assertions are on what reaches the clipboard, the API,
// and the local DB, never on intermediate state.

const CLOUD_ID = "cloud-note-1";
const PREFIX = "ow_share_abc1234";
const TOKEN = `${PREFIX}${"x".repeat(25)}`;
const ROTATED_AWAY_TOKEN = `ow_share_zzz9999${"y".repeat(25)}`;
const NEW_PREFIX = "ow_share_new0000";
const NEW_TOKEN = `${NEW_PREFIX}${"n".repeat(25)}`;

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
  "/hooks/useAuth": `
    export const useAuth = () => ({ user: { name: "Owner", email: "owner@acme.com" } });
  `,
  "/hooks/usePolicy": `export const usePolicySnapshot = () => ({});`,
  "/stores/policyRules": `
    export const filterShareVisibilityOptions = (options) => options;
    export const hasUsableExternalShareVisibility = () => true;
    export const isShareActionAllowed = () => true;
  `,
  "/services/SyncService.js": `export const syncService = { ensureNoteSynced: async () => null };`,
  "/services/NoteSharingService.js": `
    const record = (name, ...args) => globalThis.__shareTest.calls.push({ name, args });
    const cached = (id) => globalThis.__shareTest.cache.get(id);
    export const NoteSharingService = {
      async getShareSettings(id) {
        record("getShareSettings", id);
        const entry = cached(id);
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
        return { share: { ...cached(id).share, visibility: "private", token_prefix: null } };
      },
      async updateAccessGrant(id, grantId, permission) {
        record("updateAccessGrant", id, grantId, permission);
        return cached(id).access.grants.find((grant) => grant.id === grantId);
      },
      async removeAccessGrant(id, grantId) {
        record("removeAccessGrant", id, grantId);
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
    export const useSpaces = () => [];
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

async function renderDialog(t, { note, entry, updateResult = null, rotateResult = null }) {
  const clipboardWrites = [];
  installBrowserGlobals(t, {
    window: { setTimeout: () => 1, clearTimeout: () => {}, electronAPI: {} },
  });
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => void clipboardWrites.push(text) },
  });
  const state = {
    cache: new Map([[CLOUD_ID, entry]]),
    calls: [],
    persisted: [],
    toasts: [],
    confirmDialogs: [],
    buttons: [],
    menuItems: [],
    updateResult,
    rotateResult,
  };
  globalThis.__shareTest = state;
  t.after(() => {
    delete globalThis.__shareTest;
    delete globalThis.navigator.clipboard;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-share-note-dialog-test-",
    mockModules: MOCK_MODULES,
  });
  const { default: ShareNoteDialog } = await vite.ssrLoadModule(
    "/components/notes/ShareNoteDialog.tsx"
  );
  renderToStaticMarkup(
    createElement(ShareNoteDialog, {
      open: true,
      onOpenChange: () => {},
      note: { id: 7, cloud_id: CLOUD_ID, is_shared: 1, share_token: null, ...note },
    })
  );

  const linkButton = state.buttons.find((props) =>
    /noteEditor\.share\.dialog\.(copyLink|createLink)/.test(textOf(props.children))
  );
  assert.ok(linkButton, "expected the link button to render");
  const callsTo = (name) => state.calls.filter((call) => call.name === name);
  return { state, linkButton, clipboardWrites, callsTo };
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
