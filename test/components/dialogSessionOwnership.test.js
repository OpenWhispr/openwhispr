const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");

for (const kind of ["workspace", "team", "invite"]) {
  test(`${kind} completion reconciles without closing/resetting a replacement dialog session`, async (t) => {
    const { dom, container, render } = await mountAuditDom(t);
    const requests = [];
    const seen = (globalThis.__dialogSession = {
      requests,
      toasts: [],
      reconciled: [],
      created: [],
      invited: [],
    });
    seen.begin = (type) => {
      const request = { ...deferred(), type };
      requests.push(request);
      return request.promise;
    };
    t.after(() => delete globalThis.__dialogSession);
    const vite = await createRendererServer(t, {
      noExternal: ["react-i18next"],
      mockModules: {
        "react-i18next": `const t=key=>key; export const useTranslation=()=>({t});`,
        "/services/WorkspacesService": `export const WorkspacesService={create:()=>globalThis.__dialogSession.begin("workspace"),listMembers:async()=>[],previewSeats:async()=>({seats_used:1,current_quantity:2,amount_due:0,currency:"usd"})};`,
        "/services/TeamsService": `export const TeamsService={create:()=>globalThis.__dialogSession.begin("team")};`,
        "/services/InvitationsService": `export const InvitationsService={send:()=>globalThis.__dialogSession.begin("invite")};`,
        "/services/spaceActions": `export const addTeamMembers=async()=>({failures:[]});`,
        policyStore: `export const usePolicyStore={getState:()=>({accountId:null,authGeneration:null})};`,
        enterpriseIdentityStore: `export const useEnterpriseIdentityStore={getState:()=>({clear(){}})};`,
        "/utils/logger": `export default {error(){}};`,
        "/hooks/useAuth": `export const useAuth=()=>({user:{id:"fake-user"}});`,
        "/ui/useToast": `export const useToast=()=>({toast:props=>globalThis.__dialogSession.toasts.push(props)});`,
        "/ui/dialog": `import React from "react"; const W=({children})=>React.createElement("div",null,children); export function Dialog({children,open,onOpenChange}){globalThis.__dialogSession.dismiss=()=>onOpenChange(false);return open?React.createElement("div",null,children):null;} export const DialogContent=W,DialogHeader=W,DialogTitle=W,DialogDescription=W,DialogFooter=W;`,
        "/MemberPickList": `export default ()=>null;`,
      },
    });
    const modulePath =
      kind === "workspace"
        ? "CreateWorkspaceDialog"
        : kind === "team"
          ? "CreateTeamDialog"
          : "InviteTeammateDialog";
    const { default: Dialog } = await vite.ssrLoadModule(`/components/${modulePath}.tsx`);
    const { useWorkspaceStore: store } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
    const auth = await vite.ssrLoadModule("/lib/authRequestContext.ts");
    let setOpen, setWorkspace;
    function Owner() {
      const [open, changeOpen] = React.useState(true);
      const [workspaceId, changeWorkspace] = React.useState("A");
      setOpen = changeOpen;
      setWorkspace = changeWorkspace;
      return React.createElement(Dialog, {
        open,
        onOpenChange: changeOpen,
        workspaceId,
        workspaceName: workspaceId,
        onCreated: (value) => seen.created.push(value),
        onInvited: (value) => seen.invited.push(value),
        onReconciled: (value) => seen.reconciled.push(value),
      });
    }
    await render(React.createElement(React.StrictMode, null, React.createElement(Owner)));
    const edit = async (value) =>
      React.act(async () => {
        const input = container.querySelector("input");
        const key = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
        input[key].onChange({ target: { value } });
      });
    const submit = () =>
      React.act(async () => {
        const form = container.querySelector("form");
        if (form) form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }));
        else
          [...container.querySelectorAll("button")]
            .find((button) => button.textContent.includes("common.create"))
            .click();
      });
    const result = (id) =>
      kind === "workspace"
        ? { id, name: id, role: "owner" }
        : kind === "team"
          ? { id, name: id, workspace_id: "A" }
          : { email_sent: true };
    const finish = (index, id) => React.act(async () => requests[index].resolve(result(id)));
    await edit(kind === "invite" ? "old@example.test" : "old draft");
    await submit();
    assert.equal(requests.length, 1);
    await React.act(async () => seen.dismiss());
    await React.act(async () => setOpen(true));
    await edit(kind === "invite" ? "new@example.test" : "new draft");
    await submit();
    await finish(0, "old-created");
    assert.ok(
      container.querySelector("input"),
      "stale completion cannot close the reopened dialog"
    );
    assert.equal(
      container.querySelector("input").value,
      kind === "invite" ? "new@example.test" : "new draft"
    );
    assert.equal(seen.reconciled.length, 1, "completed action still reconciles");
    assert.equal(seen.toasts.length, 0);
    assert.equal(seen.created.length + seen.invited.length, 0);
    assert.equal(
      [...container.querySelectorAll("button")].at(-1).disabled,
      true,
      "stale finally cannot release newer submission"
    );
    await finish(1, "current-created");
    assert.equal(container.querySelector("input"), null);
    assert.equal(seen.created.length + seen.invited.length, 1);
    assert.equal(seen.reconciled.length, 2);
    if (kind === "workspace")
      assert.deepEqual(
        store.getState().workspaces.map((w) => w.id),
        ["old-created", "current-created"]
      );

    await React.act(async () => setOpen(true));
    await edit(kind === "invite" ? "fail@example.test" : "failure draft");
    await submit();
    await React.act(async () => seen.dismiss());
    await React.act(async () => setOpen(true));
    await edit(kind === "invite" ? "kept@example.test" : "kept draft");
    const count = seen.toasts.length;
    await React.act(async () => requests[2].reject(new Error("obsolete failure")));
    assert.equal(seen.toasts.length, count);
    assert.equal(
      container.querySelector("input").value,
      kind === "invite" ? "kept@example.test" : "kept draft"
    );

    await submit();
    await React.act(async () => {
      auth.observeAuthTokenStateEvent({ generation: 7, hasToken: true });
      store.getState().resetForAccountChange();
    });
    await edit(kind === "invite" ? "replacement@example.test" : "replacement draft");
    await finish(3, "old-account");
    assert.equal(
      container.querySelector("input").value,
      kind === "invite" ? "replacement@example.test" : "replacement draft"
    );
    assert.equal(seen.reconciled.length, 2);
    if (kind === "workspace") assert.deepEqual(store.getState().workspaces, []);

    if (kind !== "workspace") {
      await submit();
      await React.act(async () => setWorkspace("B"));
      await edit(kind === "invite" ? "B@example.test" : "B draft");
      await finish(4, "origin-A");
      assert.equal(
        container.querySelector("input").value,
        kind === "invite" ? "B@example.test" : "B draft"
      );
      assert.equal(seen.reconciled.length, 3, "resource replacement retains origin reconciliation");
    }
  });
}

test("invitation pricing retires on reopen and ignores an obsolete preview after roster fallback", async (t) => {
  const { dom, container, render } = await mountAuditDom(t);
  const seen = (globalThis.__invitationPricing = {
    previews: [],
    rosters: [],
    sends: [],
    toasts: [],
    invited: [],
    reconciled: [],
  });
  seen.begin = (kind, workspaceId) => {
    const request = { ...deferred(), workspaceId };
    seen[kind].push(request);
    return request.promise;
  };
  t.after(() => delete globalThis.__invitationPricing);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t=(key,values)=>key==="workspaces.invite.seatUsage"?key+":"+values.used+"/"+values.seats:key==="workspaces.invite.seatCost"?key+":"+values.amount:key;export const useTranslation=()=>({t});`,
      "/services/WorkspacesService": `export const WorkspacesService={previewSeats:id=>globalThis.__invitationPricing.begin("previews",id),listMembers:id=>globalThis.__invitationPricing.begin("rosters",id)};`,
      "/services/InvitationsService": `export const InvitationsService={send:id=>globalThis.__invitationPricing.begin("sends",id)};`,
      policyStore: `export const usePolicyStore={getState:()=>({accountId:null,authGeneration:null})};`,
      enterpriseIdentityStore: `export const useEnterpriseIdentityStore={getState:()=>({clear(){}})};`,
      "/utils/logger": `export default {error(){}};`,
      "/ui/useToast": `export const useToast=()=>({toast:props=>globalThis.__invitationPricing.toasts.push(props)});`,
      "/ui/dialog": `import React from "react";const W=({children})=>React.createElement("div",null,children);export function Dialog({children,open,onOpenChange}){globalThis.__invitationPricing.dismiss=()=>onOpenChange(false);return open?React.createElement("div",null,children):null;}export const DialogContent=W,DialogHeader=W,DialogTitle=W,DialogDescription=W,DialogFooter=W;`,
    },
  });
  const { default: Dialog } = await vite.ssrLoadModule("/components/InviteTeammateDialog.tsx");
  const { useWorkspaceStore: store } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const auth = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  const { formatAmount } = await vite.ssrLoadModule("/utils/formatAmount.ts");
  store.setState({ workspaces: [{ id: "A", name: "A", role: "owner", seats: 2 }] });
  let setOpen, setWorkspace;
  function Owner() {
    const [open, changeOpen] = React.useState(true);
    const [workspaceId, changeWorkspace] = React.useState("A");
    setOpen = changeOpen;
    setWorkspace = changeWorkspace;
    return React.createElement(Dialog, {
      open,
      onOpenChange: changeOpen,
      workspaceId,
      workspaceName: workspaceId,
      onInvited: (email) => seen.invited.push(email),
      onReconciled: (email) => seen.reconciled.push(email),
    });
  }
  const quote = (used, amount) => ({
    seats_used: used,
    current_quantity: used,
    amount_due: amount,
    currency: "usd",
  });
  const usage = () =>
    [...container.querySelectorAll("p")].find((p) =>
      p.textContent.startsWith("workspaces.invite.seatUsage:")
    )?.textContent;
  const cost = () =>
    [...container.querySelectorAll("p")].find((p) =>
      p.textContent.startsWith("workspaces.invite.seatCost:")
    )?.textContent;
  const assertNoPricing = () => {
    assert.equal(usage(), undefined, "new owner cannot retain old occupancy");
    assert.equal(cost(), undefined, "new owner cannot retain old charge");
  };
  const reopen = async () => {
    await React.act(async () => seen.dismiss());
    await React.act(async () => setOpen(true));
  };
  await render(React.createElement(Owner));
  await React.act(async () => seen.previews.at(-1).resolve(quote(2, 1200)));
  assert.equal(usage(), "workspaces.invite.seatUsage:2/2");
  assert.equal(cost(), `workspaces.invite.seatCost:${formatAmount(1200, "usd")}`);

  await reopen();
  assertNoPricing();
  const obsolete = seen.previews.at(-1);
  await reopen();
  assertNoPricing();
  await React.act(async () => seen.previews.at(-1).reject(new Error("no subscription")));
  assertNoPricing();
  assert.equal(seen.rosters.length, 1, "current preview failure requests roster fallback");
  await React.act(async () => seen.rosters[0].resolve([{ id: "current-member" }]));
  assert.equal(usage(), "workspaces.invite.seatUsage:1/2");
  assert.equal(cost(), undefined, "fallback must not restore the retired billed quote");
  await React.act(async () => obsolete.reject(new Error("obsolete preview failure")));
  assert.equal(usage(), "workspaces.invite.seatUsage:1/2");
  assert.equal(cost(), undefined);
  assert.equal(seen.rosters.length, 1, "obsolete failure must not dispatch a fallback read");

  await React.act(async () => {
    store.setState({ workspaces: [{ id: "B", name: "B", role: "owner", seats: 3 }] });
    setWorkspace("B");
  });
  assertNoPricing();
  assert.equal(seen.previews.at(-1).workspaceId, "B");
  await React.act(async () => seen.previews.at(-1).resolve(quote(3, 3400)));
  assert.equal(usage(), "workspaces.invite.seatUsage:3/3");
  assert.equal(cost(), `workspaces.invite.seatCost:${formatAmount(3400, "usd")}`);

  const previewCount = seen.previews.length;
  await React.act(async () => {
    auth.observeAuthTokenStateEvent({ generation: 7, hasToken: true });
    store.getState().resetForAccountChange();
    store.setState({ workspaces: [{ id: "B", name: "B", role: "owner", seats: 4 }] });
  });
  assertNoPricing();
  assert.equal(seen.previews.length, previewCount + 1, "account replacement starts a new read");
  const pending = seen.previews.at(-1);
  await React.act(async () => {
    const input = container.querySelector("input");
    const key = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    input[key].onChange({ target: { value: "current@example.test" } });
  });
  assert.equal(container.querySelector('button[type="submit"]').disabled, false);
  await React.act(async () => {
    container
      .querySelector("form")
      .dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(seen.sends.length, 1, "Send is not gated by pending pricing");
  await React.act(async () => seen.sends[0].resolve({ email_sent: true }));
  assert.equal(container.querySelector("input"), null);
  assert.deepEqual(seen.invited, ["current@example.test"]);
  assert.deepEqual(seen.reconciled, ["current@example.test"]);
  assert.equal(seen.toasts.length, 1, "current send still publishes success");
  await React.act(async () => pending.resolve(quote(4, 5600)));
  await React.act(async () => setOpen(true));
  assertNoPricing();
});

test("real Groups creation reconciles through core and mounted roster once; dismissed/reopened creation suppresses assignment success/error feedback", async (t) => {
  const { dom, container, render } = await mountAuditDom(t);
  const seen = (globalThis.__spaceCompletion = {
    toasts: [],
    creations: [],
    assignments: [],
    mirrors: [],
    reads: 0,
    members: [],
  });
  seen.begin = (kind, path, input) => {
    const request = { ...deferred(), path, input };
    seen[kind].push(request);
    return request.promise;
  };
  seen.get = async (path) => {
    if (path === "/api/spaces/cloud-A/members") {
      seen.reads++;
      return { data: seen.members };
    }
    if (path === "/api/me/spaces") return seen.begin("mirrors", path);
    if (path === "/api/workspaces/A/teams" || path === "/api/workspaces/A/members")
      return { data: [] };
    throw new Error(`Unexpected GET ${path}`);
  };
  seen.post = (path, input) => {
    if (path === "/api/workspaces/A/teams") return seen.begin("creations", path, input);
    if (path === "/api/spaces/cloud-A/teams") return seen.begin("assignments", path, input);
    throw new Error(`Unexpected POST ${path}`);
  };
  t.after(() => delete globalThis.__spaceCompletion);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t=key=>key;export const useTranslation=()=>({t,i18n:{language:"en"}});`,
      "/ui/useToast": `export const useToast=()=>({toast:props=>globalThis.__spaceCompletion.toasts.push(props)});`,
      "/hooks/useAuth": `export const useAuth=()=>({user:{id:"self"}});`,
      "/cloudApi.js": `export const cloudGet=path=>globalThis.__spaceCompletion.get(path),cloudPost=(path,input)=>globalThis.__spaceCompletion.post(path,input);export const cloudGetForAuthValidation=cloudGet;export const cloudPatch=()=>{throw Error("Unexpected PATCH")},cloudDelete=()=>{throw Error("Unexpected DELETE")};`,
      "/SyncService": `export const upsertCloudSpaces=async()=>{},markSpacePurged=async()=>{},syncService={requestSyncAll(){}};`,
      "/stores/noteStore": `export const loadSpaces=async()=>{},purgeSpace=async()=>{},updateSpaceMeta=async()=>{};`,
      policyStore: `export const usePolicyStore={getState:()=>({accountId:null,authGeneration:null})};`,
      enterpriseIdentityStore: `export const useEnterpriseIdentityStore={getState:()=>({clear(){}})};`,
      "/utils/logger": `export default {error(){}};`,
    },
  });
  const { default: Panel } = await vite.ssrLoadModule("/components/notes/SpaceMembersPanel.tsx");
  const { useWorkspaceStore: store } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  store.setState({ workspaces: [{ id: "A", name: "A", role: "owner" }] });
  await render(
    React.createElement(Panel, {
      space: {
        id: 1,
        name: "Origin",
        cloud_space_id: "cloud-A",
        workspace_id: "A",
        teams: [],
        role: "admin",
      },
    })
  );
  const settle = () => React.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const click = async (text, scope = dom.document) => {
    await React.act(async () => {
      const button = [...scope.querySelectorAll("button")].find((node) =>
        node.textContent.includes(text)
      );
      assert.ok(button, `Control exists: ${text}`);
      assert.equal(button.disabled, false);
      button.click();
    });
    // Match the existing real-dialog harness's delayed Radix focus cleanup.
    await settle();
  };
  const edit = (value) =>
    React.act(async () => {
      const input = dom.document.querySelector("#create-team-name");
      assert.ok(input, "real creation form is mounted");
      const key = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
      input[key].onChange({ target: { value } });
    });
  const create = async (name) => {
    await edit(name);
    await click("common.create");
    assert.deepEqual(seen.creations.at(-1).input, { name });
  };
  const finishCreation = (id) =>
    React.act(async () => {
      seen.creations.at(-1).resolve({ data: { id, name: id, workspace_id: "A" } });
    });
  const finishAssignment = (name) =>
    React.act(async () => {
      seen.members = [
        {
          user_id: name,
          name,
          email: `${name}@example.test`,
          image: null,
          role: "member",
          direct_role: null,
          via_teams: [{ team_id: name, name, role: "member", access: "admin" }],
        },
      ];
      seen.assignments.at(-1).resolve();
    });
  const finishMirror = () => React.act(async () => seen.mirrors.at(-1).resolve({ data: [] }));
  await click("notes.spaces.groups.title", container);
  assert.equal(seen.reads, 1);
  await click("notes.spaces.teams.newTeam", container);
  await create("current");
  await finishCreation("current");
  assert.deepEqual(seen.assignments.at(-1).input, { team_id: "current" });
  await finishAssignment("current-member");
  assert.equal(seen.reads, 2, "server success invalidates before the pending mirror read");
  assert.ok(
    container.textContent.includes("current-member"),
    "mounted real roster publishes fresh members"
  );
  assert.equal(seen.toasts.length, 0, "feedback waits for mirror completion");
  await finishMirror();
  await settle();
  assert.equal(seen.reads, 2, "Groups completion does not dispatch a second roster read");
  assert.equal(seen.toasts.at(-1).title, "notes.spaces.teamsMembers.teamAdded");
  assert.equal(dom.document.querySelector("#create-team-name"), null, "current creation closes");

  // Each old creation is still pending when the real Close control retires
  // its lease. Only then does its same-account reconciliation assign the team.
  for (const success of [true, false]) {
    await click("notes.spaces.teams.newTeam", container);
    await create(success ? "stale-success" : "stale-error");
    await click("common.close");
    assert.equal(dom.document.querySelector("#create-team-name"), null);
    await click("notes.spaces.teams.newTeam", container);
    await edit("replacement draft");
    const toasts = seen.toasts.length,
      reads = seen.reads,
      writes = seen.assignments.length;
    await finishCreation(success ? "stale-success" : "stale-error");
    assert.equal(
      seen.assignments.length,
      writes + 1,
      "dismissed same-account creation still assigns"
    );
    if (success) {
      await finishAssignment("reconciled-member");
      await finishMirror();
      assert.equal(seen.reads, reads + 1);
      assert.ok(container.textContent.includes("reconciled-member"));
    } else {
      await React.act(async () =>
        seen.assignments.at(-1).reject(new Error("obsolete assignment failure"))
      );
      assert.equal(seen.reads, reads, "failed server write does not invalidate");
    }
    assert.equal(
      seen.toasts.length,
      toasts,
      "isolated stale assignment success/error cannot toast"
    );
    assert.equal(dom.document.querySelector("#create-team-name").value, "replacement draft");
    await click("common.close");
  }

  await click("notes.spaces.teams.newTeam", container);
  await create("mirror-failure");
  await finishCreation("mirror-failure");
  const reads = seen.reads,
    toasts = seen.toasts.length;
  await finishAssignment("server-written-member");
  await React.act(async () => seen.mirrors.at(-1).reject(new Error("current mirror failure")));
  assert.equal(seen.reads, reads + 1, "mirror failure cannot prevent service invalidation");
  assert.ok(container.textContent.includes("server-written-member"));
  assert.equal(seen.toasts.length, toasts + 1, "current assignment failure stays visible");
  assert.equal(seen.toasts.at(-1).description, "current mirror failure");
  assert.equal(seen.toasts.at(-1).variant, "destructive");
});
