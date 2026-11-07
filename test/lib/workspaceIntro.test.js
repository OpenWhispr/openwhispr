const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/lib/workspaceIntro.ts");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

const workspace = (id = "acme") => ({
  kind: "workspace",
  current: { id, name: "Acme Studio", role: "member" },
  canInvite: false,
});

const input = (overrides = {}) => ({
  storage: memoryStorage(),
  accountId: "user-1",
  switcher: workspace(),
  blocked: false,
  ...overrides,
});

test("shows for a workspace not yet seen", async () => {
  const { shouldShowWorkspaceIntro } = await load();

  assert.equal(shouldShowWorkspaceIntro(input()), true);
});

test("never shows for personal, loading or error switcher states", async () => {
  const { shouldShowWorkspaceIntro } = await load();

  for (const kind of ["personal", "loading", "error", "hidden"]) {
    assert.equal(shouldShowWorkspaceIntro(input({ switcher: { kind } })), false, kind);
  }
  assert.equal(shouldShowWorkspaceIntro(input({ accountId: null })), false, "no account");
});

test("blocked while settings or create/invite is open", async () => {
  const { shouldShowWorkspaceIntro } = await load();

  assert.equal(shouldShowWorkspaceIntro(input({ blocked: true })), false);
});

test("marked seen hides it for that workspace only", async () => {
  const { markWorkspaceIntroSeen, shouldShowWorkspaceIntro, workspaceIntroKey } = await load();
  const storage = memoryStorage();

  markWorkspaceIntroSeen(storage, "user-1", "acme");

  assert.equal(storage.getItem(workspaceIntroKey("user-1", "acme")), "1");
  assert.equal(shouldShowWorkspaceIntro(input({ storage })), false);
  assert.equal(shouldShowWorkspaceIntro(input({ storage, switcher: workspace("globex") })), true);
});

test("another account on the same device sees it again", async () => {
  const { markWorkspaceIntroSeen, shouldShowWorkspaceIntro } = await load();
  const storage = memoryStorage();

  markWorkspaceIntroSeen(storage, "user-1", "acme");

  assert.equal(shouldShowWorkspaceIntro(input({ storage, accountId: "user-2" })), true);
});

test("an older intro version shows again", async () => {
  const { WORKSPACE_INTRO_VERSION, shouldShowWorkspaceIntro, workspaceIntroKey } = await load();
  const storage = memoryStorage({
    [workspaceIntroKey("user-1", "acme")]: String(WORKSPACE_INTRO_VERSION - 1),
  });

  assert.equal(shouldShowWorkspaceIntro(input({ storage })), true);
});

test("storage that throws shows nothing", async () => {
  const { markWorkspaceIntroSeen, shouldShowWorkspaceIntro } = await load();
  const broken = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };

  assert.equal(shouldShowWorkspaceIntro(input({ storage: broken })), false);
  assert.doesNotThrow(() => markWorkspaceIntroSeen(broken, "user-1", "acme"));
});
