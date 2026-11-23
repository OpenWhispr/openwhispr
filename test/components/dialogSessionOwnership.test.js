const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");

// Main's redesigned team and invite dialogs replaced the fenced ones these cases
// pinned; their own tests (createTeamDialog, inviteTeammateDialog) cover them now.
for (const kind of ["workspace"]) {
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
        "react-i18next": `const t=key=>key; export const useTranslation=()=>({t}); export const initReactI18next={type:"3rdParty",init(){}};`,
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
