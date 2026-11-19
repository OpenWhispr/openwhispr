const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act, createElement } = React;
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHappyDom,
  installHostDom,
} = require("../lib/rendererTestHarness");

const ROLE_CAPS = {
  owner: { manage_settings: true, delete_workspace: true, transfer_ownership: true, leave: false },
  admin: { manage_settings: true, delete_workspace: false, transfer_ownership: false, leave: true },
  member: {
    manage_settings: false,
    delete_workspace: false,
    transfer_ownership: false,
    leave: true,
  },
};

const WORKSPACE = { id: "w1", name: "Acme Research", seats: 5 };

// `realCapabilities` reads the workspace's own capabilities, as the app does. `dom` is for a
// test that installed happy-dom itself, to click. `interactions` stubs only the icon encoder.
async function loadSection(
  t,
  { realCapabilities = false, dom = false, interactions = false } = {}
) {
  t.after(() => {
    delete globalThis.__caps;
    delete globalThis.__settingsWorkspace;
    delete globalThis.__exitDialogProps;
    delete globalThis.__iconTest;
  });
  if (!dom) installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-general-section-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/i18n": "export default { t: (key) => key };",
      "/useSettingsWorkspace": `
        export const useSettingsWorkspace = () => globalThis.__settingsWorkspace;
      `,
      // The frame's loading, error and empty states are covered with the frame itself.
      "/SettingsWorkspaceFrame": `
        export default function Frame({ state, children }) {
          return state.workspace ? children(state.workspace) : null;
        }
      `,
      ...(realCapabilities
        ? {}
        : {
            "/lib/capabilities": `
              export const workspaceCan = (workspace, capability) =>
                globalThis.__caps?.[capability] === true;
            `,
          }),
      "/services/workspaceActions": `
        export const leaveWorkspace = async () => {};
        export const deleteWorkspace = async () => {};
        export const transferOwnership = async () => {};
      `,
      "/services/WorkspacesService": globalThis.__iconTest?.realService
        ? 'export { WorkspacesService } from "/services/WorkspacesService.ts";'
        : `export const WorkspacesService = globalThis.__iconTest?.service ?? {};`,
      "/lib/authRequestContext": `
        export const getValidatedAuthGeneration = () =>
          globalThis.__iconTest ? globalThis.__iconTest.authGeneration : 7;
      `,
      "/cloudApi.js": `
        import { CloudApiError } from "/services/cloudApi.ts";
        export { CloudApiError };
        // As main answers: a refusal comes back as { failure } and the request throws it.
        const answer = (result) => {
          if (!result?.failure) return result;
          const { message, status, code } = result.failure;
          throw new CloudApiError(message, status, code);
        };
        export const cloudGet = () => {};
        export const cloudPatch = () => {};
        export const cloudDelete = () => {};
        export const cloudPost = () => {};
        export const cloudPostForAuthGeneration = async (path, body, generation) =>
          answer(await globalThis.__iconTest.request(path, body, generation));
      `,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) =>
          selector({
            refresh: async (options) => globalThis.__iconTest?.refresh(options),
            workspaces: globalThis.__settingsWorkspace?.workspaces ?? [],
          });
      `,
      "/hooks/useAuth": "export const useAuth = () => ({ user: { id: 'u-self', name: 'Ada' } });",
      "/ui/useToast": `
        export const useToast = () => ({ toast: (value) => globalThis.__iconTest?.toasts.push(value) });
      `,
      ...(interactions
        ? {
            "/lib/workspaceIcon": `
          import { WorkspaceIconUnreadableError } from "/lib/workspaceIcon.ts";
          export {
            WORKSPACE_ICON_INPUT_TYPES,
            WorkspaceIconUnreadableError,
            checkWorkspaceIconFile,
          } from "/lib/workspaceIcon.ts";
          export const encodeWorkspaceIcon = (file) =>
            globalThis.__iconTest.encode(file, WorkspaceIconUnreadableError);
        `,
          }
        : {}),
      "/EnterpriseConsoleRow": "export default function Mock() { return null; }",
      "/WorkspaceExitDialog": `
        import React from "react";
        export function WorkspaceExitDialog(props) {
          globalThis.__exitDialogProps = props;
          return React.createElement("div", { "data-exit-dialog": "" });
        }
      `,
      "/TransferOwnershipDialog": `
        import React from "react";
        export function TransferOwnershipDialog() {
          return React.createElement("div", { "data-transfer-dialog": "" });
        }
      `,
    },
  });
  return vite.ssrLoadModule("/components/settings/WorkspaceGeneralSection.tsx");
}

function render(
  module,
  { role, name = WORKSPACE.name, caps = ROLE_CAPS[role], iconUrl, extra = {} }
) {
  const workspace = { ...WORKSPACE, name, role, icon_url: iconUrl, ...extra };
  globalThis.__caps = caps;
  globalThis.__settingsWorkspace = {
    status: "ready",
    workspace,
    workspaces: [workspace],
    retry: () => {},
  };
  return renderToStaticMarkup(createElement(module.default, { onNavigateToSection: () => {} }));
}

const nameInput = (markup) => {
  const match = markup.match(
    /<input[^>]*aria-label="settingsPage\.workspace\.general\.nameLabel"[^>]*>/
  );
  assert.ok(match, "name input");
  return match[0];
};

const ROW = {
  owner: "settingsPage.workspace.general.ownerTitle",
  delete: "settingsPage.workspace.general.dangerTitle",
  leave: "settingsPage.workspace.general.leaveTitle",
};

test("owner sees transfer and delete, no leave", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, { role: "owner" });

  assert.match(markup, /settingsPage\.workspace\.general\.subtitleManage/);
  assert.ok(markup.includes(ROW.owner));
  assert.ok(markup.includes("workspaces.transfer.submit"));
  assert.ok(markup.includes(ROW.delete));
  assert.ok(markup.includes("settingsPage.workspace.general.dangerDescription"));
  assert.ok(!markup.includes(ROW.leave));
});

test("admin sees an editable name and leave, no delete or transfer", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, { role: "admin" });

  assert.doesNotMatch(nameInput(markup), /disabled=""/);
  assert.match(markup, /common\.save/);
  assert.ok(markup.includes(ROW.leave));
  assert.ok(markup.includes("settingsPage.workspace.general.leaveDescription"));
  assert.ok(!markup.includes(ROW.delete));
  assert.ok(!markup.includes(ROW.owner));
});

test("member sees a read-only name and leave", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, { role: "member" });

  assert.match(markup, /settingsPage\.workspace\.general\.subtitleView/);
  assert.match(nameInput(markup), /disabled=""/);
  assert.doesNotMatch(markup, /common\.save/);
  assert.ok(markup.includes(ROW.leave));
  assert.ok(!markup.includes(ROW.delete));
  assert.ok(!markup.includes(ROW.owner));
});

test("long existing name shows in full with Save disabled", async (t) => {
  const module = await loadSection(t);
  const longName = "A".repeat(36) + " " + "B".repeat(35);
  assert.equal(longName.length, 72);
  const markup = render(module, { role: "owner", name: longName });

  const input = nameInput(markup);
  assert.ok(input.includes(`value="${longName}"`), "the name is not truncated");
  assert.match(input, /maxLength="65"|maxlength="65"/i);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>common\.save<\/button>/);
  assert.match(markup, /settingsPage\.workspace\.general\.nameHint/);
});

test("Save needs a changed, non-empty name of at most 65 characters", async (t) => {
  const { canSaveWorkspaceName, WORKSPACE_NAME_MAX } = await loadSection(t);
  assert.equal(WORKSPACE_NAME_MAX, 65);
  const saved = "Acme";
  assert.equal(canSaveWorkspaceName("Acme", saved), false);
  assert.equal(canSaveWorkspaceName("  Acme  ", saved), false);
  assert.equal(canSaveWorkspaceName("   ", saved), false);
  assert.equal(canSaveWorkspaceName("Acme Labs", saved), true);
  assert.equal(canSaveWorkspaceName("x".repeat(65), saved), true);
  assert.equal(canSaveWorkspaceName("x".repeat(66), saved), false);
  // An existing 72-character name stays unsaveable until it is shortened.
  const long = "y".repeat(72);
  assert.equal(canSaveWorkspaceName(long.slice(0, 70), long), false);
  assert.equal(canSaveWorkspaceName(long.slice(0, 65), long), true);
});

test("rows follow server capabilities, not the role", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, {
    role: "member",
    caps: { ...ROLE_CAPS.member, delete_workspace: true, leave: false },
  });

  assert.ok(markup.includes(ROW.delete));
  assert.ok(!markup.includes(ROW.leave));
  assert.ok(!markup.includes(ROW.owner));

  // An owner whose session the server holds back (e.g. Require SSO) gets no owner rows.
  const blockedOwner = render(module, {
    role: "owner",
    caps: { manage_settings: false, delete_workspace: false, transfer_ownership: false },
  });
  assert.ok(!blockedOwner.includes(ROW.delete));
  assert.ok(!blockedOwner.includes(ROW.owner));
  assert.match(nameInput(blockedOwner), /disabled=""/);
});

test("delete is unavailable for the default workspace", async (t) => {
  const module = await loadSection(t, { realCapabilities: true });
  const capabilities = {
    manage_members: true,
    manage_teams: true,
    create_spaces: true,
    manage_settings: true,
    manage_billing: true,
    transfer_ownership: true,
    leave: false,
  };

  const own = render(module, {
    role: "owner",
    extra: {
      is_default: true,
      is_account_default: true,
      capabilities: { ...capabilities, delete_workspace: false },
    },
  });
  assert.ok(!own.includes(ROW.delete));
  assert.ok(own.includes(ROW.owner), "the rest of the owner's page stays");

  const another = render(module, {
    role: "owner",
    extra: {
      is_default: false,
      is_account_default: false,
      capabilities: { ...capabilities, delete_workspace: true },
    },
  });
  assert.ok(another.includes(ROW.delete));
});

test("the leave dialog keeps naming where private notes go while the leave runs", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const happyWindow = await installHappyDom(t);
  const module = await loadSection(t, { dom: true });
  const lab = { id: "mine", name: "Ada's lab", role: "owner", is_default: true };
  const acme = { ...WORKSPACE, role: "member", is_default: false };
  globalThis.__caps = ROLE_CAPS.member;
  globalThis.__settingsWorkspace = {
    status: "ready",
    workspace: acme,
    workspaces: [acme, lab],
    retry: () => {},
  };
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  root = createRoot(host);
  const show = () =>
    React.act(async () =>
      root.render(createElement(module.default, { onNavigateToSection: () => {} }))
    );
  const dialog = () => globalThis.__exitDialogProps;

  await show();
  const leave = [...host.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === "settingsPage.workspace.general.leave"
  );
  await React.act(async () => leave.click());
  assert.equal(dialog().state.kind, "confirmLeave");
  assert.equal(dialog().privateNotesWorkspace, "Ada's lab");

  // While it runs the store forgets Acme and lands on the default (another window switching
  // does the same): the sentence keeps the destination it was confirmed with.
  await React.act(async () => dialog().dispatch({ type: "confirm" }));
  globalThis.__settingsWorkspace = {
    status: "ready",
    workspace: lab,
    workspaces: [lab],
    retry: () => {},
  };
  await show();
  assert.equal(dialog().state.kind, "leaving");
  assert.equal(dialog().privateNotesWorkspace, "Ada's lab");

  // The outcome says where the user is now.
  await React.act(async () => dialog().dispatch({ type: "succeeded" }));
  assert.equal(dialog().state.kind, "left");
  assert.equal(dialog().currentWorkspace, "Ada's lab");
});

const ICON = "https://abc.public.blob.vercel-storage.com/workspace-icons/w1/icon-a.webp";
const fileInput = (markup) => markup.match(/<input[^>]*type="file"[^>]*>/)?.[0];

test("an admin without a picture sees initials and Upload", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, { role: "admin" });

  assert.match(markup, />AR</);
  assert.match(fileInput(markup), /accept="image\/png,image\/jpeg,image\/webp,image\/gif"/);
  assert.ok(markup.includes("settingsPage.workspace.general.iconUpload"));
  assert.ok(!markup.includes("settingsPage.workspace.general.iconRemove"));
});

test("an existing picture shows with Change and Remove", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, { role: "owner", iconUrl: ICON });

  assert.ok(markup.includes(`src="${ICON}"`));
  assert.ok(markup.includes("settingsPage.workspace.general.iconChange"));
  assert.ok(markup.includes("settingsPage.workspace.general.iconRemove"));
});

test("a member sees the picture without controls", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, { role: "member", iconUrl: ICON });

  assert.ok(markup.includes(`src="${ICON}"`));
  assert.equal(fileInput(markup), undefined);
  assert.ok(!markup.includes("settingsPage.workspace.general.iconUpload"));
  assert.ok(!markup.includes("settingsPage.workspace.general.iconRemove"));
});

test("shows the user's own role", async (t) => {
  const module = await loadSection(t);

  for (const role of ["owner", "admin", "member"]) {
    const markup = render(module, { role });
    assert.match(markup, /settingsPage\.workspace\.general\.roleLabel/);
    assert.ok(markup.includes(`settingsPage.workspace.role.${role}`));
  }
});

function propsOf(node) {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function findNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.childNodes) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return undefined;
}

async function mountIconControls(t, overrides = {}) {
  let root;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
  });
  const state = {
    calls: [],
    refreshes: [],
    toasts: [],
    authGeneration: 7,
    encode: async () => "encoded-webp",
    ...overrides,
  };
  state.service = {
    uploadIcon: async (...args) => state.calls.push(["upload", ...args]),
    removeIcon: async (...args) => state.calls.push(["remove", ...args]),
    update: async (...args) => state.calls.push(["update", ...args]),
    ...overrides.service,
  };
  state.refresh = overrides.refresh ?? (async (options) => state.refreshes.push(options));
  globalThis.__iconTest = state;
  const module = await loadSection(t, { interactions: true });
  globalThis.__caps = ROLE_CAPS.admin;
  const container = installHostDom(t);
  root = createRoot(container);
  const show = (workspace) => {
    globalThis.__settingsWorkspace = { workspace, workspaces: [workspace], status: "ready" };
    return act(async () => root.render(createElement(module.default)));
  };
  await show({ ...WORKSPACE, role: "admin", icon_url: ICON });
  return {
    state,
    show,
    get input() {
      return findNode(container, (node) => propsOf(node).type === "file");
    },
    button: (key) =>
      findNode(
        container,
        (node) =>
          node.tagName === "BUTTON" &&
          node.textContent.endsWith(`settingsPage.workspace.general.${key}`)
      ),
  };
}

test("upload clears the picker, disables both controls, then refreshes and announces success", async (t) => {
  let finishEncoding;
  const encoding = new Promise((resolve) => {
    finishEncoding = resolve;
  });
  const view = await mountIconControls(t, { encode: () => encoding });
  assert.ok(view.input, "file picker");
  const file = { type: "image/png", size: 100 };
  const target = { files: [file], value: "same-image.png" };
  await act(async () => propsOf(view.input).onChange({ target }));

  assert.equal(target.value, "");
  assert.equal(propsOf(view.button("iconUploading")).disabled, true);
  assert.equal(propsOf(view.button("iconRemove")).disabled, true);
  assert.deepEqual(view.state.calls, []);

  await act(async () => finishEncoding("encoded-webp"));
  assert.deepEqual(view.state.calls, [["upload", "w1", "encoded-webp", 7]]);
  assert.deepEqual(view.state.refreshes, [{ fresh: true }]);
  assert.deepEqual(view.state.toasts, [{ title: "settingsPage.workspace.general.iconUploaded" }]);
  assert.equal(propsOf(view.button("iconChange")).disabled, false);
  assert.equal(propsOf(view.button("iconRemove")).disabled, false);
});

test("remove keeps both controls disabled until the fresh workspace refresh finishes", async (t) => {
  let finishRefresh;
  const refreshing = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const view = await mountIconControls(t, { refresh: () => refreshing });
  assert.ok(view.button("iconRemove"), "remove button");
  await act(async () => propsOf(view.button("iconRemove")).onClick());

  assert.deepEqual(view.state.calls, [["remove", "w1"]]);
  assert.equal(propsOf(view.button("iconChange")).disabled, true);
  assert.equal(propsOf(view.button("iconRemove")).disabled, true);
  assert.deepEqual(view.state.toasts, []);

  await act(async () => finishRefresh());
  assert.deepEqual(view.state.toasts, [{ title: "settingsPage.workspace.general.iconRemoved" }]);
  assert.equal(propsOf(view.button("iconRemove")).disabled, false);
});

test("unsupported and oversized uploads stop before encoding or sending requests", async (t) => {
  let encodes = 0;
  const view = await mountIconControls(t, {
    encode: async () => {
      encodes++;
    },
  });
  assert.ok(view.input, "file picker");
  for (const [file, message] of [
    [{ type: "image/svg+xml", size: 100 }, "iconUnsupported"],
    [{ type: "image/jpeg", size: 10485761 }, "iconTooLarge"],
  ]) {
    const target = { files: [file], value: "image" };
    await act(async () => propsOf(view.input).onChange({ target }));
    assert.equal(target.value, "");
    assert.deepEqual(view.state.toasts.at(-1), {
      title: "common.error",
      description: `settingsPage.workspace.general.${message}`,
      variant: "destructive",
    });
  }
  assert.equal(encodes, 0);
  assert.deepEqual(view.state.calls, []);
  assert.deepEqual(view.state.refreshes, []);
});

const PICK_PNG = { target: { files: [{ type: "image/png", size: 100 }], value: "image" } };

for (const [failure, message] of [
  ["decode", "iconUnreadable"],
  ["upload", "iconFailed"],
  ["remove", "iconFailed"],
]) {
  test(`${failure} failures show translated copy and restore icon controls`, async (t) => {
    const fail = async (_file, Unreadable) => {
      throw failure === "decode" ? new Unreadable("decode failed") : new Error(`${failure} failed`);
    };
    const view = await mountIconControls(t, {
      ...(failure === "decode" ? { encode: fail } : {}),
      service: {
        ...(failure === "upload" ? { uploadIcon: fail } : {}),
        ...(failure === "remove" ? { removeIcon: fail } : {}),
      },
    });
    assert.ok(view.input, "file picker");
    await act(async () => {
      if (failure === "remove") propsOf(view.button("iconRemove")).onClick();
      else propsOf(view.input).onChange(PICK_PNG);
    });
    assert.deepEqual(view.state.toasts, [
      {
        title: "common.error",
        description: `settingsPage.workspace.general.${message}`,
        variant: "destructive",
      },
    ]);
    assert.equal(propsOf(view.button("iconChange")).disabled, false);
    assert.equal(propsOf(view.button("iconRemove")).disabled, false);
    if (failure === "decode") assert.deepEqual(view.state.calls, []);
  });
}

test("icon service calls use the workspace icon route and unwrap Workspace responses", async (t) => {
  const calls = [];
  const workspace = { ...WORKSPACE, icon_url: ICON };
  globalThis.__iconApi = (method, path, body, authGeneration) => {
    calls.push({ method, path, body, ...(authGeneration === undefined ? {} : { authGeneration }) });
    return { data: workspace };
  };
  t.after(() => {
    delete globalThis.__iconApi;
  });
  const vite = await createRendererServer(t, {
    mockModules: {
      "/cloudApi.js": `
        export const cloudGet = () => {};
        export const cloudPatch = () => {};
        export const cloudPost = () => {};
        export const cloudPostForAuthGeneration = async (path, body, generation) =>
          globalThis.__iconApi("POST", path, body, generation);
        export const cloudDelete = async (path) => globalThis.__iconApi("DELETE", path);
      `,
    },
  });
  const { WorkspacesService } = await vite.ssrLoadModule("/services/WorkspacesService.ts");
  assert.equal(await WorkspacesService.uploadIcon("w1", "encoded-webp", 7), workspace);
  assert.equal(await WorkspacesService.removeIcon("w1"), workspace);
  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/api/workspaces/w1/icon",
      body: { data: "encoded-webp" },
      authGeneration: 7,
    },
    { method: "DELETE", path: "/api/workspaces/w1/icon", body: undefined },
  ]);
});

test("an account switch during encoding keeps the upload pinned to its initiating account", async (t) => {
  let finishEncoding;
  const encoding = new Promise((resolve) => {
    finishEncoding = resolve;
  });
  const requests = [];
  const mutatedAccounts = [];
  const view = await mountIconControls(t, {
    realService: true,
    encode: () => encoding,
    request: async (path, body, authGeneration) => {
      requests.push({ path, body, authGeneration });
      // The main process refuses a pinned request after the credential generation changes.
      if (authGeneration !== globalThis.__iconTest.authGeneration) {
        return {
          failure: {
            message: "Authentication context changed before request",
            status: 0,
            code: "AUTH_CONTEXT_CHANGED",
          },
        };
      }
      mutatedAccounts.push(authGeneration);
      return { data: WORKSPACE };
    },
  });
  await act(async () => propsOf(view.input).onChange(PICK_PNG));
  assert.deepEqual(requests, []);
  view.state.authGeneration = 8;
  await act(async () => finishEncoding("encoded-webp"));

  assert.deepEqual(requests, [
    {
      path: "/api/workspaces/w1/icon",
      body: { data: "encoded-webp" },
      authGeneration: 7,
    },
  ]);
  assert.deepEqual(mutatedAccounts, []);
  assert.deepEqual(view.state.refreshes, []);
  assert.deepEqual(view.state.toasts, [
    {
      title: "common.error",
      description: "settingsPage.workspace.general.iconSignInChanged",
      variant: "destructive",
    },
  ]);
  assert.equal(propsOf(view.button("iconChange")).disabled, false);
  assert.equal(propsOf(view.button("iconRemove")).disabled, false);
});

test("a selection without a validated account stops before encoding or uploading", async (t) => {
  let encodes = 0;
  const view = await mountIconControls(t, {
    authGeneration: null,
    encode: async () => {
      encodes++;
      return "encoded-webp";
    },
  });
  await act(async () => propsOf(view.input).onChange(PICK_PNG));

  assert.equal(encodes, 0);
  assert.deepEqual(view.state.calls, []);
  assert.deepEqual(view.state.refreshes, []);
  assert.deepEqual(view.state.toasts, [
    {
      title: "common.error",
      description: "auth.unconfirmedSession",
      variant: "destructive",
    },
  ]);
  assert.equal(propsOf(view.button("iconChange")).disabled, false);
});

test("server refusals of an upload read as translated copy, or the server's own reason", async (t) => {
  let refusal;
  const view = await mountIconControls(t, {
    realService: true,
    request: async () => ({ failure: refusal }),
  });
  for (const [failure, description] of [
    [
      { message: "Service temporarily unavailable", status: 503, code: "SERVER_ERROR" },
      "settingsPage.workspace.general.iconUnavailable",
    ],
    [
      { message: "Insufficient role", status: 403 },
      "settingsPage.workspace.general.iconNotAllowed",
    ],
    [
      { message: "Sign in with company SSO", status: 403, code: "SSO_REQUIRED" },
      "settingsPage.workspace.general.iconSsoRequired",
    ],
    [
      {
        message: "Too many workspace icon uploads. Try again later.",
        status: 429,
        code: "rate_limited",
      },
      "settingsPage.workspace.general.iconRateLimited",
    ],
    [{ message: "Network request failed", status: 0 }, "settingsPage.workspace.general.iconFailed"],
    [
      { message: "Upload a PNG, JPEG or WebP image", status: 400 },
      "Upload a PNG, JPEG or WebP image",
    ],
  ]) {
    refusal = failure;
    await act(async () => propsOf(view.input).onChange(PICK_PNG));
    assert.equal(view.state.toasts.at(-1).description, description, failure.message);
  }
  assert.deepEqual(view.state.refreshes, []);
});

test("switching workspace mid-upload leaves the next workspace's controls alone", async (t) => {
  let finishEncoding;
  const encoding = new Promise((resolve) => {
    finishEncoding = resolve;
  });
  const view = await mountIconControls(t, { encode: () => encoding });
  await act(async () => propsOf(view.input).onChange(PICK_PNG));
  assert.equal(propsOf(view.button("iconUploading")).disabled, true);

  await view.show({ ...WORKSPACE, id: "w2", name: "Beta Labs", role: "admin", icon_url: null });
  assert.ok(!view.button("iconUploading"), "the next workspace isn't uploading");
  assert.equal(propsOf(view.button("iconUpload")).disabled, false);

  // The upload still lands on the workspace it started on.
  await act(async () => finishEncoding("encoded-webp"));
  assert.deepEqual(view.state.calls, [["upload", "w1", "encoded-webp", 7]]);
  assert.equal(propsOf(view.button("iconUpload")).disabled, false);
});

test("focus returns to the upload button only when finishing left it nowhere", async (t) => {
  const view = await mountIconControls(t);
  const focused = [];
  view.button("iconChange").focus = () => focused.push("upload");

  await act(async () => propsOf(view.input).onChange(PICK_PNG));
  assert.deepEqual(focused, ["upload"]);

  // Somewhere the user moved focus during the removal keeps it.
  globalThis.document.activeElement = view.button("iconRemove");
  await act(async () => propsOf(view.button("iconRemove")).onClick());
  assert.deepEqual(view.state.calls.at(-1), ["remove", "w1"]);
  assert.deepEqual(focused, ["upload"]);
});
