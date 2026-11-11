const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

const note = (id, title, spaceId) => ({
  id,
  title,
  content: "",
  space_id: spaceId,
  folder_id: null,
  updated_at: new Date().toISOString(),
});

// Mounts the dialog for folder 7 in `folderSpaceId`, over `spaces` and `notes`, with the workspace
// store in `workspaceState`, and returns its text.
async function renderDialog(t, options) {
  return textOf((await mountDialog(t, options)).container);
}

async function mountDialog(
  t,
  { spaces, notes, workspaceState, folderSpaceId, updateNote = async () => ({ success: true }) }
) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const toasts = [];
  const events = { added: 0, closed: 0 };
  globalThis.__addNotesToasts = toasts;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNotes: async (_type, limit, _folderId, _spaceId, spaceIds) =>
          notes.filter((n) => !spaceIds || spaceIds.includes(n.space_id)).slice(0, limit),
        updateNote,
      },
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-add-notes-to-folder-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = (key) => key; export const useTranslation = () => ({ t });`,
      "/hooks/useUiLocale": `export const useUiLocale = () => "en";`,
      "/ui/dialog": `
        import React from "react";
        const Pass = ({ children }) => React.createElement("div", null, children);
        export const Dialog = ({ open, children }) => (open ? Pass({ children }) : null);
        export const DialogContent = Pass;
        export const DialogTitle = Pass;
      `,
      "/stores/noteStore": `
        const spaces = ${JSON.stringify(spaces)};
        const folders = [{ id: 7, space_id: ${folderSpaceId}, name: "Target", is_default: 0 }];
        export const useSpaces = () => spaces;
        export const useFolders = () => folders;
        export const useShareCache = () => new Map();
      `,
      "/useAuth": `export const useAuth = () => ({ isSignedIn: true, user: { id: "me" } });`,
      "/ui/useToast": `export const useToast = () => ({
        toast: (options) => globalThis.__addNotesToasts.push(options),
      });`,
      "/stores/workspaceStore": `
        const state = {
          ...${JSON.stringify(workspaceState)},
          error: false,
          refresh: async () => {},
          setActiveWorkspaceId() {},
        };
        export const useWorkspaceStore = (selector) => selector(state);
      `,
    },
  });
  const { default: AddNotesToFolderDialog } = await vite.ssrLoadModule(
    "/components/notes/AddNotesToFolderDialog.tsx"
  );

  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(AddNotesToFolderDialog, {
        open: true,
        onOpenChange: (open) => {
          if (!open) events.closed += 1;
        },
        targetFolderId: 7,
        onNotesAdded: () => {
          events.added += 1;
        },
      })
    )
  );
  return { container, toasts, events };
}

function findButton(node, text) {
  if (node.nodeName === "BUTTON" && textOf(node).includes(text)) return node;
  for (const child of node.childNodes ?? []) {
    const found = findButton(child, text);
    if (found) return found;
  }
  return null;
}

async function click(node) {
  const propsKey = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  await React.act(async () => node[propsKey].onClick());
}

const acmeAndOther = [
  { id: "acme", name: "Acme", role: "member", is_default: true },
  { id: "other", name: "Other", role: "member", is_default: false },
];

test("Add existing never offers a note from a workspace the switcher hides", async (t) => {
  // Newest first, as the query orders them: enough Acme notes to fill the dialog's limit.
  const text = await renderDialog(t, {
    spaces: [
      { id: 1, kind: "private", workspace_id: null },
      { id: 2, kind: "team", workspace_id: "acme" },
    ],
    folderSpaceId: 1,
    notes: [
      ...Array.from({ length: 500 }, (_, i) => note(100 + i, "Acme roadmap", 2)),
      note(1, "Personal plan", 1),
    ],
    workspaceState: {
      workspaces: acmeAndOther,
      activeWorkspaceId: "other",
      defaultWorkspaceId: "other",
      loaded: true,
    },
  });
  assert.match(text, /Personal plan/);
  assert.doesNotMatch(text, /Acme roadmap/, "moving it here would pull it out of Acme");
});

test("the Add existing picker offers only the active workspace's notes", async (t) => {
  const text = await renderDialog(t, {
    spaces: [
      { id: 1, kind: "private", workspace_id: "acme" },
      { id: 2, kind: "team", workspace_id: "acme" },
      { id: 3, kind: "private", workspace_id: "other" },
      { id: 4, kind: "team", workspace_id: "other" },
    ],
    // A teamspace folder takes the workspace's own notes, private or team.
    folderSpaceId: 4,
    notes: [
      note(1, "Acme private", 1),
      note(2, "Acme roadmap", 2),
      note(3, "Other private", 3),
      note(4, "Other plan", 4),
    ],
    workspaceState: {
      workspaces: acmeAndOther,
      activeWorkspaceId: "other",
      defaultWorkspaceId: "acme",
      loaded: true,
    },
  });
  assert.match(text, /Other private/);
  assert.match(text, /Other plan/);
  assert.doesNotMatch(text, /Acme private/, "another workspace's Private stays in that workspace");
  assert.doesNotMatch(text, /Acme roadmap/);
});

test("Add existing offers the saved workspace's Private while the list loads", async (t) => {
  // The launch before the workspace list answers: the active workspace comes from storage and the
  // default isn't known yet.
  const text = await renderDialog(t, {
    spaces: [
      { id: 1, kind: "private", workspace_id: "acme", is_default_private: 1 },
      { id: 3, kind: "private", workspace_id: "other" },
    ],
    folderSpaceId: 3,
    notes: [note(1, "Acme private", 1), note(3, "Other private", 3)],
    workspaceState: {
      workspaces: [],
      activeWorkspaceId: "other",
      defaultWorkspaceId: null,
      loaded: false,
    },
  });
  assert.match(text, /Other private/);
  assert.doesNotMatch(text, /Acme private/);
});

test("Add existing offers only notes that may move into the folder's space", async (t) => {
  const spaces = [
    { id: 1, kind: "private", workspace_id: "acme", account_id: "me" },
    {
      id: 2,
      kind: "team",
      workspace_id: "acme",
      cloud_space_id: "cs-2",
      my_role: "member",
      teams: [],
    },
    {
      id: 5,
      kind: "team",
      workspace_id: "acme",
      cloud_space_id: "cs-5",
      my_role: "member",
      teams: [],
    },
  ];
  const synced = (id, title, spaceId, owner) => ({
    ...note(id, title, spaceId),
    cloud_id: `cloud-${id}`,
    owner_user_id: owner,
  });
  const notes = [
    note(1, "My private plan", 1),
    synced(2, "Alpha spec", 2, "me"),
    synced(5, "My ops note", 5, "me"),
    synced(6, "Teammate ops note", 5, "teammate"),
  ];
  const workspaceState = {
    workspaces: [{ id: "acme", name: "Acme", role: "member", is_default: true }],
    activeWorkspaceId: "acme",
    defaultWorkspaceId: "acme",
    loaded: true,
  };

  // Into Private: a team note would only be copied, never moved, so none is offered.
  const intoPrivate = await renderDialog(t, { spaces, notes, workspaceState, folderSpaceId: 1 });
  assert.match(intoPrivate, /My private plan/);
  assert.doesNotMatch(intoPrivate, /Alpha spec/);
  assert.doesNotMatch(intoPrivate, /ops note/);
});

test("Add existing into a teamspace leaves out a teammate's note from another teamspace", async (t) => {
  const spaces = [
    { id: 1, kind: "private", workspace_id: "acme", account_id: "me" },
    {
      id: 2,
      kind: "team",
      workspace_id: "acme",
      cloud_space_id: "cs-2",
      my_role: "member",
      teams: [],
    },
    {
      id: 5,
      kind: "team",
      workspace_id: "acme",
      cloud_space_id: "cs-5",
      my_role: "member",
      teams: [],
    },
  ];
  const synced = (id, title, spaceId, owner) => ({
    ...note(id, title, spaceId),
    cloud_id: `cloud-${id}`,
    owner_user_id: owner,
  });
  const text = await renderDialog(t, {
    spaces,
    notes: [
      note(1, "My private plan", 1),
      synced(2, "Teammate alpha spec", 2, "teammate"),
      synced(5, "My ops note", 5, "me"),
      synced(6, "Teammate ops note", 5, "teammate"),
    ],
    workspaceState: {
      workspaces: [{ id: "acme", name: "Acme", role: "member", is_default: true }],
      activeWorkspaceId: "acme",
      defaultWorkspaceId: "acme",
      loaded: true,
    },
    folderSpaceId: 2,
  });
  assert.match(text, /My private plan/, "a private note moves into its workspace's teamspace");
  assert.match(text, /Teammate alpha spec/, "a folder of the note's own teamspace is a re-filing");
  assert.match(text, /My ops note/, "its owner may move a note between teamspaces");
  assert.doesNotMatch(
    text,
    /Teammate ops note/,
    "only its owner or an admin may change its audience"
  );
});

// The tree's own rule (crossesUnknownWorkspace): until the default workspace is known, the
// section's pending Private may be another workspace's, so a note from it isn't offered here.
test("while the default workspace is unknown, Add existing leaves out the other Private's notes", async (t) => {
  const text = await renderDialog(t, {
    spaces: [
      { id: 3, kind: "private", workspace_id: "other" },
      { id: 9, kind: "private", workspace_id: null },
    ],
    folderSpaceId: 3,
    notes: [note(3, "Other private", 3), note(9, "Pending private", 9)],
    workspaceState: {
      workspaces: acmeAndOther.map((w) => ({ ...w, is_default: false })),
      activeWorkspaceId: "other",
      defaultWorkspaceId: null,
      loaded: true,
    },
  });
  assert.match(text, /Other private/);
  assert.doesNotMatch(text, /Pending private/, "it might be another workspace's note");
});

test("an add main refuses is shown, not ignored", async (t) => {
  const { container, toasts, events } = await mountDialog(t, {
    spaces: [
      { id: 1, kind: "private", workspace_id: "acme" },
      { id: 2, kind: "team", workspace_id: "acme", cloud_space_id: "cs-2", my_role: "member" },
    ],
    folderSpaceId: 1,
    notes: [note(1, "Kept", 1), note(2, "Refused", 1)],
    workspaceState: {
      workspaces: [{ id: "acme", name: "Acme", role: "member", is_default: true }],
      activeWorkspaceId: "acme",
      defaultWorkspaceId: "acme",
      loaded: true,
    },
    updateNote: async (id) =>
      id === 2 ? { success: false, error: "Folder not found" } : { success: true },
  });
  await click(findButton(container, "Kept"));
  await click(findButton(container, "Refused"));
  await click(findButton(container, "notes.addToFolder.addCount"));

  assert.equal(events.added, 1, "the note that moved still shows in the folder");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, "notes.addToFolder.notAdded");
  assert.equal(toasts[0].description, "notes.mutationErrors.folderNotFound");
  assert.equal(toasts[0].variant, "destructive");
});
