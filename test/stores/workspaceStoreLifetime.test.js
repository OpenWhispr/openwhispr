const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

test("old member and workspace replies cannot repopulate state after a switch or account reset", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  const pendingMembers = [];
  const pendingLists = [];
  const pendingCreates = [];
  globalThis.__pendingWorkspaceMembers = pendingMembers;
  globalThis.__pendingWorkspaceLists = pendingLists;
  globalThis.__pendingWorkspaceCreates = pendingCreates;
  t.after(() => {
    delete globalThis.__pendingWorkspaceMembers;
    delete globalThis.__pendingWorkspaceLists;
    delete globalThis.__pendingWorkspaceCreates;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-store-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "/services/InvitationsService": `export const InvitationsService = {list: async () => []};`,
      "/MemberAvatar": `export default function Avatar() {return null;}`,
      "/InviteTeammateDialog": `export default function Invite() {return null;}`,
      "/ui/dialog": `export const ConfirmDialog = () => null;`,
      "/ui/useToast": `export const useToast = () => ({toast() {}});`,
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          listMembers: () => new Promise((resolve) => globalThis.__pendingWorkspaceMembers.push(resolve)),
          list: () => new Promise((resolve) => globalThis.__pendingWorkspaceLists.push(resolve)),
          create: () => new Promise((resolve) => globalThis.__pendingWorkspaceCreates.push(resolve)),
        };
      `,
      "/utils/logger": `export default { error() {} };`,
      "/stores/policyStore": `export const usePolicyStore = { getState: () => ({ accountId: null, authGeneration: null }) };`,
      "/stores/enterpriseIdentityStore": `export const useEnterpriseIdentityStore = { getState: () => ({ clear() {} }) };`,
    },
  });
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const store = useWorkspaceStore;
  store.setState({
    workspaces: [{ id: "one" }, { id: "two" }],
    activeWorkspaceId: "one",
    loaded: true,
  });
  const old = store.getState().refreshMembers("one");
  store.getState().setActiveWorkspaceId("two");
  pendingMembers.shift()([{ user_id: "old" }]);
  await old;
  assert.deepEqual(
    store.getState().membersByWorkspace.one,
    [{ user_id: "old" }],
    "non-active queries keep their actual workspace owner"
  );
  assert.equal(store.getState().membersByWorkspace.two, undefined);

  const current = store.getState().refreshMembers("two");
  const oldList = store.getState().refresh();
  const oldCreate = store.getState().createWorkspace("Old account workspace");
  store.getState().resetForAccountChange();
  pendingMembers.shift()([{ user_id: "previous-account" }]);
  pendingLists.shift()([{ id: "old-workspace" }]);
  pendingCreates.shift()({ id: "old-workspace" });
  assert.equal(await oldCreate, null);
  await Promise.all([current, oldList]);
  assert.deepEqual(store.getState().membersByWorkspace, {});
  assert.deepEqual(store.getState().workspaces, []);
  assert.equal(store.getState().loaded, false);

  store.setState({ workspaces: [{ id: "one" }, { id: "two" }], activeWorkspaceId: "one" });
  const earlyA = store.getState().refreshMembers("one");
  store.getState().setActiveWorkspaceId("two");
  const currentB = store.getState().refreshMembers("two");
  const followupA = store.getState().refreshMembers("one");
  const [resolveEarlyA, resolveB, resolveFollowupA] = pendingMembers.splice(0);
  resolveB([{ user_id: "B" }]);
  await currentB;
  resolveFollowupA([{ user_id: "A-new" }]);
  await followupA;
  resolveEarlyA([{ user_id: "A-old" }]);
  await earlyA;
  assert.deepEqual(store.getState().membersByWorkspace, {
    one: [{ user_id: "A-new" }],
    two: [{ user_id: "B" }],
  });
  assert.equal(store.getState().activeWorkspaceId, "two");
  const implicitSwitch = store.getState().refresh();
  pendingLists.shift()([{ id: "one" }]);
  await implicitSwitch;
  assert.equal(store.getState().activeWorkspaceId, "one");
  assert.deepEqual(
    store.getState().membersByWorkspace.one,
    [{ user_id: "A-new" }],
    "implicit selection never re-labels another roster"
  );

  const { default: Tab } = await vite.ssrLoadModule("/components/settings/WorkspaceMembersTab.tsx");
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(
        "div",
        null,
        React.createElement(
          "div",
          { hidden: true },
          React.createElement(Tab, {
            workspace: { id: "one", name: "A", role: "member", seats: 2 },
          })
        ),
        React.createElement(
          "div",
          null,
          React.createElement(Tab, {
            workspace: { id: "two", name: "B", role: "member", seats: 2 },
          })
        )
      )
    )
  );
  await React.act(async () => {
    pendingMembers.shift()([
      { user_id: "a", email: "a@example.test", name: "Member-A", role: "member" },
    ]);
    pendingMembers.shift()([
      { user_id: "b", email: "b@example.test", name: "Member-B", role: "member" },
    ]);
  });
  store.getState().setActiveWorkspaceId("two");
  const followup = store.getState().refreshMembers("one");
  await React.act(async () =>
    pendingMembers.shift()([
      { user_id: "a", email: "a@example.test", name: "Member-A-updated", role: "member" },
    ])
  );
  await followup;
  const [a, b] = container.firstChild.childNodes;
  assert.match(a.textContent, /Member-A-updated/);
  assert.doesNotMatch(a.textContent, /Member-B/);
  assert.match(b.textContent, /Member-B/);
  assert.doesNotMatch(b.textContent, /Member-A/);
});
