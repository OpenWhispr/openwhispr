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

test("a failed load with nothing listed is an error, saved workspace or not", async () => {
  const { resolveWorkspaceSwitcher } = await load();

  assert.deepEqual(resolveWorkspaceSwitcher({ ...base, error: true }), { kind: "error" });
});

test("a cached list survives a failed refresh", async () => {
  const { resolveWorkspaceSwitcher } = await load();
  const acme = workspace("acme");

  assert.equal(
    resolveWorkspaceSwitcher({ ...base, error: true, workspaces: [acme] }).kind,
    "workspace"
  );
});

test("an empty list waits for the default workspace instead of offering Personal", async () => {
  const { resolveWorkspaceSwitcher } = await load();

  assert.deepEqual(resolveWorkspaceSwitcher(base), { kind: "loading" });
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

test("with none chosen, the account's default comes before the first listed", async () => {
  const { defaultActiveWorkspaceId } = await load();
  const pro = { id: "beta", plan: "pro", status: "active", is_default: false };
  const own = { id: "mine", plan: "free", status: "active", is_default: true };
  const enterprise = { id: "acme", plan: "enterprise", status: "active", is_default: false };

  assert.equal(defaultActiveWorkspaceId([pro, own]), "mine");
  // Managed providers apply only while the Enterprise workspace is active, so it stays first.
  assert.equal(defaultActiveWorkspaceId([pro, own, enterprise]), "acme");
});

test("the default workspace is the account's own, else its entitled Enterprise workspace", async () => {
  const { resolveDefaultWorkspaceId } = await load();
  const pro = { id: "beta", plan: "pro", status: "active", is_default: false };
  const own = { id: "mine", plan: "free", status: "active", is_default: true };
  const enterprise = (status) => ({ id: "acme", plan: "enterprise", status, is_default: false });
  // Another member's default reads is_default false for this caller.
  const someoneElses = { ...pro, id: "theirs", is_account_default: true };

  assert.equal(resolveDefaultWorkspaceId([pro, enterprise("active"), own]), "mine");
  assert.equal(resolveDefaultWorkspaceId([pro, enterprise("active")]), "acme");
  assert.equal(resolveDefaultWorkspaceId([pro, enterprise("canceled")]), null);
  assert.equal(resolveDefaultWorkspaceId([someoneElses]), null);
  assert.equal(resolveDefaultWorkspaceId([]), null);
});

test("the switcher never offers Personal", async () => {
  const switcher = await load();

  assert.equal("canChoosePersonal" in switcher, false);
  const state = switcher.resolveWorkspaceSwitcher({
    ...base,
    workspaces: [workspace("acme")],
    activeWorkspaceId: null,
  });
  assert.equal(state.kind, "workspace");
});

test("Settings manages the active workspace, or the first when the active id is gone", async () => {
  const { settingsWorkspace } = await load();
  const acme = workspace("acme");
  const beta = workspace("beta");

  assert.equal(settingsWorkspace([acme, beta], "beta"), beta);
  assert.equal(settingsWorkspace([acme, beta], "gone"), acme);
  assert.equal(settingsWorkspace([acme, beta], null), acme);
  assert.equal(settingsWorkspace([], null), null);
});

test("the default workspace is named after the user, or generically without a name", async () => {
  const { defaultWorkspaceName } = await load();
  const i18next = require("i18next");
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: require("../../src/locales/en/translation.json") } },
    interpolation: { escapeValue: false },
  });
  const t = i18n.t.bind(i18n);

  assert.equal(defaultWorkspaceName("Ada", t), "Ada's workspace");
  assert.equal(defaultWorkspaceName("  O'Brien  ", t), "O'Brien's workspace");
  assert.equal(defaultWorkspaceName("", t), "My workspace");
  assert.equal(defaultWorkspaceName(null, t), "My workspace");
  // The API refuses names over 80 characters.
  assert.equal(defaultWorkspaceName("x".repeat(80), t), "My workspace");
});
