const test = require("node:test");
const assert = require("node:assert/strict");

function installStorage() {
  const values = new Map();
  global.localStorage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
}

test("local workspace exists without hosted account state and can be renamed", async () => {
  installStorage();
  const { getLocalWorkspace, renameLocalWorkspace, LOCAL_WORKSPACE_ID } =
    await import("../../src/services/LocalWorkspaceService.ts");

  const initial = getLocalWorkspace();
  assert.equal(initial.id, LOCAL_WORKSPACE_ID);
  assert.equal(initial.plan, "local");
  assert.equal(initial.role, "owner");
  assert.equal(initial.stripe_subscription_id, null);

  const renamed = renameLocalWorkspace("Clinic Notes");
  assert.equal(renamed.name, "Clinic Notes");
  assert.equal(getLocalWorkspace().name, "Clinic Notes");
});

test("local teams are local metadata only", async () => {
  installStorage();
  const { createLocalTeam, deleteLocalTeam, listLocalTeams, LOCAL_WORKSPACE_ID } =
    await import("../../src/services/LocalWorkspaceService.ts");

  assert.deepEqual(listLocalTeams(), []);

  const team = createLocalTeam("Admissions");
  assert.equal(team.workspace_id, LOCAL_WORKSPACE_ID);
  assert.equal(team.name, "Admissions");
  assert.equal(team.member_count, 0);
  assert.equal(listLocalTeams().length, 1);

  deleteLocalTeam(team.id);
  assert.deepEqual(listLocalTeams(), []);
});
