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

async function loadSection(t, { interactions = false } = {}) {
  t.after(() => {
    delete globalThis.__caps;
    delete globalThis.__settingsWorkspace;
    delete globalThis.__iconTest;
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-general-section-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/useSettingsWorkspace": `
        export const useSettingsWorkspace = () => globalThis.__settingsWorkspace;
      `,
      // The frame's loading, error and empty states are covered with the frame itself.
      "/SettingsWorkspaceFrame": `
        export default function Frame({ state, children }) {
          return state.workspace ? children(state.workspace) : null;
        }
      `,
      "/lib/capabilities": `
        export const workspaceCan = (workspace, capability) =>
          globalThis.__caps?.[capability] === true;
      `,
      "/services/workspaceActions": `
        export const leaveWorkspace = async () => {};
        export const deleteWorkspace = async () => {};
        export const transferOwnership = async () => {};
      `,
      "/services/WorkspacesService": `
        export const WorkspacesService = globalThis.__iconTest?.service ?? {};
      `,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) => selector({ refresh: async (options) => globalThis.__iconTest?.refresh(options) });
      `,
      "/hooks/useAuth": "export const useAuth = () => ({ user: { id: 'u-self' } });",
      "/ui/useToast": `
        export const useToast = () => ({ toast: (value) => globalThis.__iconTest?.toasts.push(value) });
      `,
      ...(interactions
        ? {
            "/lib/workspaceIcon": `
          export { WORKSPACE_ICON_INPUT_TYPES, checkWorkspaceIconFile } from "/lib/workspaceIcon.ts";
          export const encodeWorkspaceIcon = (file) => globalThis.__iconTest.encode(file);
        `,
          }
        : {}),
      "/EnterpriseConsoleRow": "export default function Mock() { return null; }",
      "/WorkspaceExitDialog": `
        import React from "react";
        export function WorkspaceExitDialog() {
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

function render(module, { role, name = WORKSPACE.name, caps = ROLE_CAPS[role], iconUrl }) {
  const workspace = { ...WORKSPACE, name, role, icon_url: iconUrl };
  globalThis.__caps = caps;
  globalThis.__settingsWorkspace = {
    status: "ready",
    workspace,
    workspaces: [workspace],
    retry: () => {},
  };
  return renderToStaticMarkup(
    createElement(module.default, { onNavigateToSection: () => {}, onChooseWorkspace: () => {} })
  );
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
  const workspace = { ...WORKSPACE, role: "admin", icon_url: ICON };
  globalThis.__caps = ROLE_CAPS.admin;
  globalThis.__settingsWorkspace = { workspace, workspaces: [workspace], status: "ready" };
  const container = installHostDom(t);
  root = createRoot(container);
  await act(async () => root.render(createElement(module.default)));
  return {
    state,
    input: findNode(container, (node) => propsOf(node).type === "file"),
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
  assert.deepEqual(view.state.calls, [["upload", "w1", "encoded-webp"]]);
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

for (const failure of ["decode", "upload", "remove", "refresh"]) {
  test(`${failure} failures show the error and restore icon controls`, async (t) => {
    const fail = async () => {
      throw new Error(`${failure} failed`);
    };
    const view = await mountIconControls(t, {
      ...(failure === "decode" ? { encode: fail } : {}),
      ...(failure === "refresh" ? { refresh: fail } : {}),
      service: {
        ...(failure === "upload" ? { uploadIcon: fail } : {}),
        ...(failure === "remove" ? { removeIcon: fail } : {}),
      },
    });
    assert.ok(view.input, "file picker");
    await act(async () => {
      if (failure === "remove") propsOf(view.button("iconRemove")).onClick();
      else
        propsOf(view.input).onChange({
          target: { files: [{ type: "image/png", size: 100 }], value: "image" },
        });
    });
    assert.deepEqual(view.state.toasts, [
      {
        title: "common.error",
        description: `${failure} failed`,
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
  globalThis.__iconApi = (method, path, body) => {
    calls.push({ method, path, body });
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
        export const cloudPost = async (path, body) => globalThis.__iconApi("POST", path, body);
        export const cloudDelete = async (path) => globalThis.__iconApi("DELETE", path);
      `,
    },
  });
  const { WorkspacesService } = await vite.ssrLoadModule("/services/WorkspacesService.ts");
  assert.equal(typeof WorkspacesService.uploadIcon, "function");
  assert.equal(await WorkspacesService.uploadIcon("w1", "encoded-webp"), workspace);
  assert.equal(await WorkspacesService.removeIcon("w1"), workspace);
  assert.deepEqual(calls, [
    { method: "POST", path: "/api/workspaces/w1/icon", body: { data: "encoded-webp" } },
    { method: "DELETE", path: "/api/workspaces/w1/icon", body: undefined },
  ]);
});
