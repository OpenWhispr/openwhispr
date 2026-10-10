const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");

async function mountRosterAdapter(t, kind) {
  const { render } = await mountAuditDom(t);
  const seen = (globalThis.__rosterOwner = {
    reads: [],
    writes: [],
    publications: [],
    toasts: [],
  });
  seen.load = (id) => {
    const read = { ...deferred(), id };
    seen.reads.push(read);
    return read.promise;
  };
  seen.mutate = (id) => {
    const write = { ...deferred(), id };
    seen.writes.push(write);
    return write.promise;
  };
  t.after(() => delete globalThis.__rosterOwner);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t=key=>key;export const useTranslation=()=>({t,i18n:{language:"en"}});`,
      "/ui/useToast": `export const useToast=()=>({toast:p=>globalThis.__rosterOwner.toasts.push(p)});`,
      "/hooks/useAuth": `export const useAuth=()=>({user:{id:"self"}});`,
      "/hooks/useDialogs": `export const useDialogs=()=>({confirmDialog:{},showConfirmDialog(){},hideConfirmDialog(){}});`,
      "/ui/dialog": `export const ConfirmDialog=()=>null;`,
      "/InviteTeammateDialog": `export default ()=>null;`,
      "/SpaceGroupsSection": `export default ()=>null;`,
      "/MemberRoster": `import React from "react";export default props=>{globalThis.__rosterOwner.props=props;return React.createElement("output",null,JSON.stringify({members:props.members,loading:props.loading,error:props.loadFailed,busy:[...props.busyIds]}));};`,
      "/services/TeamsService": `export const TeamsService={listMembers:id=>globalThis.__rosterOwner.load(id)};`,
      "/services/SpacesService": `export const SpacesService={listMembers:id=>globalThis.__rosterOwner.load(id)};`,
      "/services/spaceActions": `
          import {invalidateSpaceRoster} from "/lib/spaceRosterCache.ts";
          const mutate=async(id)=>{
            const result=await globalThis.__rosterOwner.mutate(id);
            invalidateSpaceRoster();
            return result;
          };
          export const setTeamMemberRole=mutate,setSpaceMemberRole=space=>mutate(space.cloud_space_id),removeTeamMember=mutate,removeSpaceMember=mutate;
          export const addTeamMembers=async(id)=>{await mutate(id);return {failures:[]}};
          export const addSpaceMembers=async(space)=>{await mutate(space.cloud_space_id);return {failures:[]}};`,
      "/stores/workspaceStore": `const state={workspaces:[{id:"ws",role:"owner"}],membersByWorkspace:{},refreshMembers:async()=>{}};export const EMPTY_WORKSPACE_MEMBERS=[];export const useWorkspaceStore=fn=>fn(state);`,
    },
  });
  const { default: Component } = await vite.ssrLoadModule(
    kind === "team"
      ? "/components/TeamRosterSection.tsx"
      : "/components/notes/SpaceMembersPanel.tsx"
  );
  const auth = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  const publish = (members) => seen.publications.push(members);
  const node = (id, onRosterChange = publish) =>
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        Component,
        kind === "team"
          ? {
              teamId: id,
              teamName: id,
              canManage: true,
              workspaceMembers: [],
              onRosterChange,
              removeConfirm() {},
            }
          : {
              space: {
                id: 1,
                name: id,
                cloud_space_id: id,
                workspace_id: "ws",
                teams: [],
                role: "admin",
              },
            }
      )
    );
  const member = (name) => ({
    user_id: name,
    email: `${name}@example.test`,
    name,
    role: "member",
    via_teams: [],
  });
  const finish = (read, name) => React.act(async () => read.resolve([member(name)]));
  return { render, seen, auth, vite, node, member, finish };
}

test("team roster accepts only owned latest reads and preserves independent row mutations", async (t) => {
  const { render, seen, auth, node, member, finish, vite } = await mountRosterAdapter(t, "team");
  await render(node("A"));
  assert.equal(seen.reads.length, 2, "StrictMode read cleanup rejects the probe");
  await finish(seen.reads[1], "fresh");
  await React.act(async () => seen.reads[0].reject(new Error("obsolete")));
  assert.equal(seen.props.members[0].name, "fresh");
  assert.equal(seen.props.loadFailed, false);
  const retry = seen.props.onRetry;
  await React.act(async () => {
    retry();
    retry();
  });
  await finish(seen.reads[3], "newest");
  await finish(seen.reads[2], "older");
  assert.equal(seen.props.members[0].name, "newest");
  assert.deepEqual(
    seen.publications.map((m) => m[0].name),
    ["fresh", "newest"]
  );

  await React.act(async () => {
    seen.props.onAdd(member("one"));
    seen.props.onAdd(member("two"));
  });
  assert.equal(seen.writes.length, 2, "different rows are not globally locked");
  assert.deepEqual([...seen.props.busyIds].sort(), ["one", "two"]);
  const readsBeforeWrites = seen.reads.length;
  await React.act(async () => seen.writes[0].resolve());
  assert.equal(
    seen.reads.length,
    readsBeforeWrites + 1,
    "service invalidation owns one post-write read"
  );
  const firstReload = seen.reads.at(-1);
  await React.act(async () => seen.writes[1].resolve());
  assert.equal(seen.reads.length, readsBeforeWrites + 2, "a second write adds only one read");
  const secondReload = seen.reads.at(-1);
  assert.notEqual(firstReload, secondReload, "every successful current write reloads");
  await finish(secondReload, "both-written");
  await finish(firstReload, "first-write-only");
  assert.equal(seen.props.members[0].name, "both-written");
  assert.equal(seen.props.busyIds.size, 0);

  {
    const replacements = [];
    await React.act(async () => seen.props.onAdd(member("callback-write")));
    const pendingWrite = seen.writes.at(-1),
      beforeReads = seen.reads.length;
    await render(node("A", (list) => replacements.push(list)));
    assert.equal(
      seen.reads.length,
      beforeReads,
      "callback replacement does not reload or drop row ownership"
    );
    assert.ok(seen.props.busyIds.has("callback-write"));
    await React.act(async () => pendingWrite.resolve());
    assert.equal(
      seen.reads.length,
      beforeReads + 1,
      "completed write must reload with unchanged resource"
    );
    await finish(seen.reads.at(-1), "callback-reloaded");
    assert.equal(replacements.at(-1)[0].name, "callback-reloaded");
    await render(node("A"));
  }
  await React.act(async () => {
    seen.props.onAdd(member("failure"));
    seen.props.onAdd(member("failure"));
  });
  const failedWrite = seen.writes.at(-1),
    writeCount = seen.writes.length;
  assert.ok(seen.props.busyIds.has("failure"));
  await React.act(async () => seen.props.onAdd(member("failure")));
  assert.equal(seen.writes.length, writeCount, "same row cannot dispatch a duplicate action");
  const failuresBefore = seen.toasts.length,
    readsBefore = seen.reads.length;
  await React.act(async () => failedWrite.reject(new Error("current mutation failed")));
  assert.equal(seen.toasts.length, failuresBefore + 1);
  assert.equal(seen.toasts.at(-1).description, "current mutation failed");
  assert.equal(seen.props.busyIds.size, 0);
  assert.equal(seen.reads.length, readsBefore);
  await React.act(async () => seen.props.onRetry());
  await React.act(async () => seen.reads.at(-1).reject(new Error("current read failed")));
  assert.equal(seen.props.loadFailed, true);
  assert.equal(seen.props.loading, false);
  await React.act(async () => seen.props.onRetry());
  await finish(seen.reads.at(-1), "recovered");
  assert.equal(seen.props.loadFailed, false);

  const oldRetry = seen.props.onRetry,
    oldAdd = seen.props.onAdd;
  await React.act(async () => seen.props.onAdd(member("pending")));
  const oldMutation = seen.writes.at(-1);
  await React.act(async () => seen.props.onRetry());
  const oldRead = seen.reads.at(-1);
  await render(node("B"));
  assert.equal(seen.props.members.length, 0);
  assert.equal(seen.props.busyIds.size, 0);
  await React.act(async () => seen.props.onAdd(member("pending")));
  const currentMutation = seen.writes.at(-1),
    pendingWrites = seen.writes.length;
  assert.equal(currentMutation.id, "B");
  assert.ok(seen.props.busyIds.has("pending"));
  await React.act(async () => oldAdd(member("obsolete-callback")));
  assert.equal(seen.writes.length, pendingWrites, "old owner callback cannot dispatch");
  const reads = seen.reads.length,
    publications = seen.publications.length,
    toasts = seen.toasts.length;
  await React.act(async () => {
    oldRetry();
    oldMutation.resolve();
    oldRead.reject(new Error("old owner"));
  });
  assert.equal(
    seen.reads.length,
    reads + 1,
    "service invalidation refreshes the live resource, not the expired loader"
  );
  assert.equal(seen.reads.at(-1).id, "B");
  assert.equal(seen.publications.length, publications);
  assert.equal(seen.toasts.length, toasts);
  assert.equal(seen.props.loading, true, "old finally cannot end B's load");
  assert.ok(seen.props.busyIds.has("pending"), "old completion cannot unlock B's same row");
  await React.act(async () => seen.props.onAdd(member("pending")));
  assert.equal(seen.writes.length, pendingWrites, "B's row stays locked until B settles");
  await finish(seen.reads.at(-1), "B-result");
  await React.act(async () => currentMutation.resolve());
  assert.equal(seen.props.busyIds.size, 0, "current completion releases B's row");
  assert.equal(seen.toasts.length, toasts + 1, "current B completion publishes feedback");
  assert.equal(seen.reads.length, reads + 2, "B's completed write adds one reconciliation read");
  assert.equal(seen.reads.at(-1).id, "B");
  await finish(seen.reads.at(-1), "B-written");
  assert.equal(seen.props.members[0].name, "B-written");
  await React.act(async () => seen.props.onRetry());
  const abaRead = seen.reads.at(-1);
  await render(node("A"));
  await render(node("B"));
  await finish(seen.reads.at(-1), "B-current");
  await finish(abaRead, "B-obsolete");
  assert.equal(
    seen.props.members[0].name,
    "B-current",
    "ABA loader replacement expires its first lease"
  );
  await React.act(async () => seen.props.onAdd(member("reopened-write")));
  const reopenedWrite = seen.writes.at(-1);
  await render(null);
  await render(node("B"));
  await finish(seen.reads.at(-1), "read-before-write");
  const reopenedCount = seen.reads.length,
    oldToasts = seen.toasts.length;
  await React.act(async () => reopenedWrite.resolve());
  assert.equal(
    seen.reads.length,
    reopenedCount + 1,
    "same-resource remount must reconcile a completed old write"
  );
  assert.equal(seen.toasts.length, oldToasts, "old local feedback stays expired");
  await finish(seen.reads.at(-1), "after-write");
  await React.act(async () => seen.props.onAdd(member("aba-write")));
  const abaWrite = seen.writes.at(-1);
  await render(node("A"));
  await render(node("B"));
  await finish(seen.reads.at(-1), "ABA-read-before-write");
  const abaCount = seen.reads.length;
  await React.act(async () => abaWrite.resolve());
  assert.equal(seen.reads.length, abaCount + 1);
  await finish(seen.reads.at(-1), "ABA-after-write");
  await React.act(async () => seen.props.onRetry());
  const oldAuthRead = seen.reads.at(-1);
  await React.act(async () => seen.props.onAdd(member("old-account-write")));
  const oldAccountWrite = seen.writes.at(-1);
  await React.act(async () => auth.observeAuthTokenStateEvent({ generation: 2, hasToken: true }));
  const newAuthRead = seen.reads.at(-1);
  await finish(newAuthRead, "new-account");
  const accountToasts = seen.toasts.length;
  await React.act(async () => oldAccountWrite.resolve());
  assert.equal(seen.toasts.length, accountToasts);
  await finish(oldAuthRead, "old-account");
  assert.equal(seen.props.members[0].name, "new-account");
  await finish(seen.reads.at(-1), "new-account");
  await React.act(async () => seen.props.onRetry());
  const unmounted = seen.reads.at(-1),
    count = seen.publications.length;
  await render(null);
  await finish(unmounted, "unmounted");
  assert.equal(seen.publications.length, count);

  // A real addTeamMembers write invalidates the real roster cache and triggers exactly one re-read.
  const { useMemberRoster } = await vite.ssrLoadModule("/hooks/useMemberRoster.ts");
  const { createSpaceActions } = await vite.ssrLoadModule("/services/spaceActionsCore.ts");
  const { invalidateSpaceRoster } = await vite.ssrLoadModule("/lib/spaceRosterCache.ts");
  let hook,
    liveMembers = [];
  const tracker = createSpaceActions({
    teams: { addMember: async (_team, userId) => { liveMembers = [...liveMembers, { user_id: userId }]; } },
    spaces: { mySpaces: async () => [] },
    local: { loadSpaces: async () => {} },
    mirror: { upsertCloudSpaces: async () => {} },
    invalidateSpaceRoster,
  });
  const liveLoad = () => seen.load("live");
  function LiveRoster() {
    hook = useMemberRoster("team:live-roster", liveLoad);
    return React.createElement("div", { ref: hook.bindRoster });
  }
  await render(React.createElement(LiveRoster));
  const liveReads = seen.reads.length;
  await React.act(async () => hook.mutate("new", () => tracker.addTeamMembers("live-team", ["new"])));
  assert.equal(seen.reads.length - liveReads, 1, "one successful real write has one refresh owner");
  assert.equal(seen.reads.at(-1).id, "live");
  await finish(seen.reads.at(-1), "new");
  assert.deepEqual(hook.members.map((entry) => entry.user_id), ["new"]);
});

test("space roster adapter switches resources and adds then reloads the current space", async (t) => {
  const { render, seen, node, member, finish } = await mountRosterAdapter(t, "space");
  await render(node("A"));
  const oldRead = seen.reads.at(-1);
  await render(node("B"));
  assert.equal(seen.reads.at(-1).id, "B", "space switch reads the new cloud resource");
  await finish(seen.reads.at(-1), "B-member");
  await finish(oldRead, "A-obsolete");
  assert.equal(seen.props.members[0].name, "B-member");

  await React.act(async () => seen.props.onAdd(member("added")));
  assert.equal(seen.writes.at(-1).id, "B", "add targets the current space, not its local id");
  await React.act(async () => seen.writes.at(-1).resolve());
  assert.equal(seen.reads.at(-1).id, "B");
  assert.equal(seen.props.loading, true, "successful add starts a fresh roster read");
  await finish(seen.reads.at(-1), "added");
  assert.equal(seen.props.members[0].name, "added");
});
