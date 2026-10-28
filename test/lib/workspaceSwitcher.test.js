const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/lib/workspaceSwitcher.ts");

const workspace = (id, role = "member") => ({ id, name: id, role });

const base = {
  isSignedIn: true,
  loaded: true,
  error: false,
  workspaces: [],
  activeWorkspaceId: null,
};

test("signed-out users get no switcher", async () => {
  const { resolveWorkspaceSwitcher } = await load();

  assert.deepEqual(resolveWorkspaceSwitcher({ ...base, isSignedIn: false }), { kind: "hidden" });
});

test("a list that hasn't arrived yet shows a placeholder", async () => {
  const { resolveWorkspaceSwitcher } = await load();

  assert.deepEqual(resolveWorkspaceSwitcher({ ...base, loaded: false }), { kind: "loading" });
});

test("a failed load is not mistaken for having no workspace", async () => {
  const { resolveWorkspaceSwitcher } = await load();

  assert.deepEqual(resolveWorkspaceSwitcher({ ...base, error: true, activeWorkspaceId: "acme" }), {
    kind: "error",
  });
});

test("offline, a user who had no workspace stays personal instead of seeing an error", async () => {
  const { resolveWorkspaceSwitcher } = await load();

  assert.deepEqual(resolveWorkspaceSwitcher({ ...base, error: true }), { kind: "personal" });
});

test("a cached list survives a failed refresh", async () => {
  const { resolveWorkspaceSwitcher } = await load();
  const acme = workspace("acme");

  assert.equal(
    resolveWorkspaceSwitcher({ ...base, error: true, workspaces: [acme] }).kind,
    "workspace"
  );
});

test("users in no workspace stay personal", async () => {
  const { resolveWorkspaceSwitcher } = await load();

  assert.deepEqual(resolveWorkspaceSwitcher(base), { kind: "personal" });
});

test("the active workspace is current", async () => {
  const { resolveWorkspaceSwitcher } = await load();
  const acme = workspace("acme");
  const beta = workspace("beta");

  const state = resolveWorkspaceSwitcher({
    ...base,
    workspaces: [acme, beta],
    activeWorkspaceId: "beta",
  });

  assert.equal(state.kind, "workspace");
  assert.equal(state.current, beta);
});

test("with no active workspace the first one is current, as in Settings", async () => {
  const { resolveWorkspaceSwitcher } = await load();
  const acme = workspace("acme");

  const state = resolveWorkspaceSwitcher({
    ...base,
    workspaces: [acme, workspace("beta")],
    activeWorkspaceId: "gone",
  });

  assert.equal(state.current, acme);
});

test("only owners and admins of the current workspace can invite from it", async () => {
  const { resolveWorkspaceSwitcher } = await load();
  const stateFor = (role) =>
    resolveWorkspaceSwitcher({
      ...base,
      workspaces: [workspace("acme", role)],
      activeWorkspaceId: "acme",
    });

  assert.equal(stateFor("owner").canInvite, true);
  assert.equal(stateFor("admin").canInvite, true);
  assert.equal(stateFor("member").canInvite, false);
});

test("inviting follows the server's manage_members capability over the role", async () => {
  const { resolveWorkspaceSwitcher } = await load();
  const stateFor = (role, manageMembers) =>
    resolveWorkspaceSwitcher({
      ...base,
      workspaces: [{ ...workspace("acme", role), capabilities: { manage_members: manageMembers } }],
      activeWorkspaceId: "acme",
    });

  assert.equal(stateFor("admin", false).canInvite, false);
  assert.equal(stateFor("member", true).canInvite, true);
});

test("with none chosen, an entitled Enterprise workspace becomes active, else the first", async () => {
  const { defaultActiveWorkspaceId } = await load();
  const pro = { id: "beta", plan: "pro", status: "active" };
  const enterprise = (status) => ({ id: "acme", plan: "enterprise", status });

  assert.equal(defaultActiveWorkspaceId([pro, enterprise("active")]), "acme");
  assert.equal(defaultActiveWorkspaceId([pro, enterprise("trialing")]), "acme");
  assert.equal(defaultActiveWorkspaceId([pro, enterprise("canceled")]), "beta");
  assert.equal(defaultActiveWorkspaceId([]), null);
});
