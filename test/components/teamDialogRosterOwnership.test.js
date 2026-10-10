const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");

test("real team dialog derives controls from current roster and expires leave confirmation/completion on detach", async (t) => {
  const { dom, render } = await mountAuditDom(t);
  const seen = (globalThis.__teamDialog = { reads: [], leaves: [], toasts: [], closes: [] });
  t.after(() => delete globalThis.__teamDialog);
  seen.load = (id) => {
    const request = { ...deferred(), id };
    seen.reads.push(request);
    return request.promise;
  };
  seen.leave = (id) => {
    const request = { ...deferred(), id };
    seen.leaves.push(request);
    return request.promise;
  };
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next", "@radix-ui/react-dialog"],
    mockModules: {
      "react-i18next": `const t=key=>key;export const useTranslation=()=>({t});`,
      "/ui/useToast": `export const useToast=()=>({toast:p=>globalThis.__teamDialog.toasts.push(p)});`,
      "/hooks/useAuth": `export const useAuth=()=>({user:{id:"self"}});`,
      "/InviteTeammateDialog": `export default ()=>null;`,
      "/MemberRoster": `export default props=>{globalThis.__teamDialog.roster=props;return null;};`,
      "/services/TeamsService": `export const TeamsService={listMembers:id=>globalThis.__teamDialog.load(id)};`,
      "/services/spaceActions": `export const leaveTeam=id=>globalThis.__teamDialog.leave(id);export const addTeamMembers=async()=>({failures:[]}),removeTeamMember=async()=>{},setTeamMemberRole=async()=>{};`,
      "/stores/workspaceStore": `export const EMPTY_WORKSPACE_MEMBERS=[];const state={membersByWorkspace:{},refreshMembers:async()=>{}};export const useWorkspaceStore=fn=>fn(state);`,
    },
  });
  const { default: TeamDialog } = await vite.ssrLoadModule(
    "/components/settings/TeamMembersDialog.tsx"
  );
  const auth = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  const node = (id, open = true, role = "member") =>
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(TeamDialog, {
        team: { id, name: id },
        workspace: { id: "workspace", role, name: "workspace" },
        open,
        onOpenChange: (value) => seen.closes.push(value),
      })
    );
  const button = (text) =>
    [...dom.document.querySelectorAll("button")]
      .filter((b) => b.textContent.trim() === text)
      .at(-1);
  const click = (text) =>
    React.act(async () => {
      assert.ok(button(text), text);
      button(text).click();
    });
  const publish = (role) =>
    React.act(async () => seen.reads.at(-1).resolve(role ? [{ user_id: "self", role }] : []));
  const leaveLabel = "settingsPage.workspace.teams.members.leave";
  await render(node("A"));
  await publish("admin");
  assert.equal(seen.roster.canManage, true);
  assert.ok(button(leaveLabel));
  await render(node("B"));
  assert.equal(seen.roster.canManage, false);
  assert.equal(button(leaveLabel), undefined);
  await publish("member");
  assert.equal(seen.roster.canManage, false);
  assert.ok(button(leaveLabel));
  await click(leaveLabel);
  assert.equal(seen.leaves.length, 0, "opening is not confirmation");
  await render(node("C"));
  await click(leaveLabel); // surviving confirmation from B is stale, never dispatches.
  assert.equal(
    seen.leaves.length,
    0,
    JSON.stringify({
      leaves: seen.leaves.map((r) => r.id),
      roster: seen.roster,
      body: dom.document.body.textContent,
    })
  );
  await publish("member");
  await click(leaveLabel);
  await click(leaveLabel);
  assert.equal(seen.leaves.length, 1);
  await render(null);
  await React.act(async () => seen.leaves[0].resolve());
  assert.equal(seen.toasts.length, 0);
  assert.equal(seen.closes.length, 0);
  await render(node("D"));
  await publish("member");
  await click(leaveLabel);
  await click(leaveLabel);
  await React.act(async () => auth.observeAuthTokenStateEvent({ generation: 7, hasToken: true }));
  await React.act(async () => seen.leaves.at(-1).reject(new Error("old account")));
  assert.equal(seen.toasts.length, 0);
  assert.equal(button(leaveLabel), undefined);
  await publish("admin");
  await click(leaveLabel);
  await click(leaveLabel);
  await React.act(async () => seen.leaves.at(-1).resolve());
  assert.equal(seen.toasts.length, 1);
  assert.deepEqual(seen.closes, [false]);
});

test("a rejected roster read settles the real picker to Retry inside the dialog", async (t) => {
  const { dom, render } = await mountAuditDom(t);
  const reads = [];
  globalThis.__teamRosterRetry = {
    load: () => {
      const request = deferred();
      reads.push(request);
      return request.promise;
    },
  };
  t.after(() => delete globalThis.__teamRosterRetry);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next", "@radix-ui/react-dialog"],
    mockModules: {
      "react-i18next": `const t=key=>key;export const useTranslation=()=>({t});`,
      "/ui/useToast": `export const useToast=()=>({toast(){}});`,
      "/hooks/useAuth": `export const useAuth=()=>({user:{id:"self"}});`,
      "/InviteTeammateDialog": `export default ()=>null;`,
      "/services/TeamsService": `export const TeamsService={listMembers:()=>globalThis.__teamRosterRetry.load()};`,
      "/services/spaceActions": `export const addTeamMembers=async()=>({failures:[]}),removeTeamMember=async()=>{},setTeamMemberRole=async()=>{};`,
      "/stores/workspaceStore": `export const EMPTY_WORKSPACE_MEMBERS=[];const state={membersByWorkspace:{},refreshMembers:async()=>{}};export const useWorkspaceStore=fn=>fn(state);`,
    },
  });
  const { default: TeamDialog } = await vite.ssrLoadModule(
    "/components/settings/TeamMembersDialog.tsx"
  );
  await render(
    React.createElement(TeamDialog, {
      team: { id: "A", name: "A" },
      workspace: { id: "workspace", role: "owner", name: "workspace" },
      open: true,
      onOpenChange() {},
    })
  );
  await React.act(async () => {
    for (const request of reads) request.reject(new Error("fake roster failure"));
  });
  const retry = [...dom.document.querySelectorAll("button")].find((button) =>
    button.textContent.includes("loadError.retry")
  );
  assert.ok(retry, "a rejected roster read settles to Retry rather than an endless skeleton");
});
