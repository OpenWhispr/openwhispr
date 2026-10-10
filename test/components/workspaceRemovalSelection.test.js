const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");

test("deleting A preserves a newer B selection and managed identity while reconciling completed removal", async (t) => {
  const { container, render } = await mountAuditDom(t);
  const seen = (globalThis.__workspaceRemoval = {
    methodCalls: [],
    mutations: [],
    lists: [],
    toasts: [],
    identity: { workspaceId: null },
  });
  seen.begin = (queue) => {
    const pending = deferred();
    seen[queue].push(pending);
    return pending.promise;
  };
  seen.call = (method, args) => {
    seen.methodCalls.push([method, ...args]);
    return seen.begin("mutations");
  };
  t.after(() => delete globalThis.__workspaceRemoval);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t=key=>key;export const useTranslation=()=>({t});`,
      "/hooks/useAuth": `export const useAuth=()=>({isSignedIn:true,user:{id:"fake-user"}});`,
      "/hooks/useLocalStorage": `import {useState} from "react";export const useLocalStorage=()=>useState("general");`,
      "/services/WorkspacesService": `export const WorkspacesService={remove:(...a)=>globalThis.__workspaceRemoval.call("remove",a),removeMember:(...a)=>globalThis.__workspaceRemoval.call("removeMember",a),list:()=>globalThis.__workspaceRemoval.begin("lists")};`,
      policyStore: `export const usePolicyStore={getState:()=>({accountId:"fake-account",authGeneration:1})};`,
      enterpriseIdentityStore: `export const useEnterpriseIdentityStore={getState:()=>({ ...globalThis.__workspaceRemoval.identity,clear:()=>{globalThis.__workspaceRemoval.identity.workspaceId=null;},refresh:(accountId,workspaceId,authGeneration)=>{globalThis.__workspaceRemoval.identity={accountId,workspaceId,authGeneration};} })};`,
      "/utils/logger": `export default {error(){}};`,
      "/ui/useToast": `export const useToast=()=>({toast:props=>globalThis.__workspaceRemoval.toasts.push(props)});`,
      "/ui/dialog": `export const ConfirmDialog=props=>{if(props.open)globalThis.__workspaceRemoval.confirm=props.onConfirm;return null;};`,
      "/CreateWorkspaceDialog": `export default ()=>null;`,
      "/InviteTeammateDialog": `export default ()=>null;`,
      "/WorkspaceMembersTab": `export default ()=>null;`,
      "/WorkspaceTeamsTab": `export default ()=>null;`,
      "/WorkspaceDeveloperTab": `export default ()=>null;`,
      "/EnterpriseConsoleRow": `export default ()=>null;`,
      "/ui/dropdown-menu": `import React from "react";const W=({children})=>React.createElement("div",null,children);export const DropdownMenu=W,DropdownMenuTrigger=W,DropdownMenuContent=W,DropdownMenuLabel=W,DropdownMenuSeparator=W;export const DropdownMenuItem=({children,onSelect})=>React.createElement("button",{onClick:onSelect},children);`,
    },
  });
  const { useWorkspaceStore: store } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const { default: Section } = await vite.ssrLoadModule(
    "/components/settings/WorkspaceSection.tsx"
  );
  const workspaces = [
    { id: "A", name: "A", role: "owner" },
    { id: "B", name: "B", role: "owner" },
    { id: "C", name: "C", role: "owner" },
  ];
  const seed = () =>
    React.act(async () =>
      store.setState({ workspaces, loaded: true, activeWorkspaceId: "A", error: false })
    );
  await seed();
  await render(React.createElement(Section));
  const start = async () => {
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "settingsPage.workspace.general.delete"
    );
    assert.ok(button, container.textContent);
    await React.act(async () => button.click());
    let pending;
    await React.act(async () => {
      pending = seen.confirm();
    });
    return { pending };
  };
  const chooseB = () =>
    React.act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "B").click()
    );
  let preWrite;
  await React.act(async () => {
    preWrite = store.getState().refresh();
  });
  const oldList = seen.lists.at(-1),
    beforeWriteLists = seen.lists.length;
  let run = await start();
  await chooseB();
  await React.act(async () => seen.mutations.at(-1).resolve());
  assert.equal(
    seen.lists.length,
    beforeWriteLists,
    "reconciliation waits for the pre-write read"
  );
  assert.equal(seen.methodCalls.at(-1)[0], "remove", "owner delete goes through remove");
  await React.act(async () => {
    oldList.resolve(workspaces);
    await preWrite;
  });
  assert.equal(
    seen.lists.length,
    beforeWriteLists + 1,
    "completion starts a fresh post-write list"
  );
  assert.equal(
    store.getState().activeWorkspaceId,
    "B",
    "completion cannot clear B before read-back"
  );
  await React.act(async () => {
    seen.lists.at(-1).resolve(workspaces.slice(1));
    await run.pending;
  });
  assert.equal(store.getState().activeWorkspaceId, "B");
  assert.equal(globalThis.localStorage.getItem("activeWorkspaceId"), "B");
  assert.equal(seen.identity.workspaceId, "B");
  assert.deepEqual(
    store.getState().workspaces.map((w) => w.id),
    ["B", "C"]
  );

  await seed();
  run = await start();
  await chooseB();
  const listCount = seen.lists.length;
  await React.act(async () => {
    seen.mutations.at(-1).reject(new Error("fake membership failure"));
    await run.pending;
  });
  assert.equal(store.getState().activeWorkspaceId, "B");
  assert.equal(seen.lists.length, listCount);
  assert.equal(seen.toasts.at(-1).description, "fake membership failure");

  await seed();
  await React.act(async () => {
    preWrite = store.getState().refresh();
  });
  const obsolete = seen.lists.at(-1),
    overlapLists = seen.lists.length;
  run = await start();
  await React.act(async () => seen.mutations.at(-1).resolve());
  await React.act(async () => {
    obsolete.resolve(workspaces);
    await preWrite;
  });
  assert.equal(seen.lists.length, overlapLists + 1);
  await React.act(async () => {
    seen.lists.at(-1).resolve(workspaces.slice(1));
    await run.pending;
  });
  assert.equal(
    store.getState().activeWorkspaceId,
    null,
    "multiple survivors do not invent a selection"
  );
  assert.equal(seen.identity.workspaceId, null);

  await seed();
  run = await start();
  await chooseB();
  await React.act(async () => seen.mutations.at(-1).resolve());
  await React.act(async () => {
    seen.lists.at(-1).reject(new Error("fake list failure"));
    await run.pending;
  });
  assert.equal(store.getState().activeWorkspaceId, "B");
  assert.equal(store.getState().error, true);

  await seed();
  run = await start();
  await React.act(async () => seen.mutations.at(-1).resolve());
  await React.act(async () => {
    store.getState().resetForAccountChange();
    store.setState({ workspaces: [workspaces[1]], loaded: true });
    store.getState().setActiveWorkspaceId("B");
  });
  await React.act(async () => {
    seen.lists.at(-1).resolve(workspaces.slice(1));
    await run.pending;
  });
  assert.equal(store.getState().activeWorkspaceId, "B");
  assert.equal(seen.identity.workspaceId, "B");
  assert.deepEqual(
    store.getState().workspaces.map((w) => w.id),
    ["B"],
    "old account read cannot repopulate membership"
  );

  // Member tail: the leave panel shows and the removal goes through removeMember with the signed-in user id.
  await React.act(async () =>
    store.setState({
      workspaces: workspaces.map((w) => (w.id === "A" ? { ...w, role: "member" } : w)),
      loaded: true,
      activeWorkspaceId: "A",
    })
  );
  await React.act(async () => {
    const leave = [...container.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "settingsPage.workspace.general.leave"
    );
    assert.ok(leave, "member workspace renders the leave panel");
    leave.click();
  });
  let leavePending;
  await React.act(async () => {
    leavePending = seen.confirm();
  });
  await React.act(async () => seen.mutations.at(-1).resolve());
  await React.act(async () => {
    seen.lists.at(-1).resolve([]);
    await leavePending;
  });
  assert.deepEqual(
    seen.methodCalls.find((call) => call[0] === "removeMember"),
    ["removeMember", "A", "fake-user"],
    "member leave takes the removeMember path with the signed-in user id"
  );
});
