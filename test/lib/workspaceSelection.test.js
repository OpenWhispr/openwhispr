const test = require("node:test");
const assert = require("node:assert/strict");
const {
  groupTeamSpacesByWorkspace,
  selectWorkspaceForSpaceCreation,
} = require("../../src/lib/workspaceSelection.ts");

const workspace = (id, role) => ({ id, name: `Workspace ${id}`, role });
const space = (id, workspaceId) => ({ id, workspace_id: workspaceId });

test("groupTeamSpacesByWorkspace: groups spaces under their workspace", () => {
  const workspaces = [workspace("a", "owner"), workspace("b", "member")];
  const spaces = [space(1, "a"), space(2, "b"), space(3, "a")];
  const { groups, ungrouped } = groupTeamSpacesByWorkspace(workspaces, spaces);
  assert.deepEqual(
    groups.map((g) => ({ id: g.workspace.id, spaceIds: g.spaces.map((s) => s.id) })),
    [
      { id: "a", spaceIds: [1, 3] },
      { id: "b", spaceIds: [2] },
    ]
  );
  assert.deepEqual(ungrouped, []);
});

test("groupTeamSpacesByWorkspace: keeps empty groups only for owners/admins", () => {
  const workspaces = [workspace("a", "owner"), workspace("b", "admin"), workspace("c", "member")];
  const { groups } = groupTeamSpacesByWorkspace(workspaces, []);
  assert.deepEqual(
    groups.map((g) => g.workspace.id),
    ["a", "b"]
  );
});

test("groupTeamSpacesByWorkspace: spaces without a known workspace are ungrouped", () => {
  const workspaces = [workspace("a", "member")];
  const spaces = [space(1, "a"), space(2, null), space(3, "gone")];
  const { groups, ungrouped } = groupTeamSpacesByWorkspace(workspaces, spaces);
  assert.deepEqual(
    groups.map((g) => g.workspace.id),
    ["a"]
  );
  assert.deepEqual(
    ungrouped.map((s) => s.id),
    [2, 3]
  );
});

test("selectWorkspaceForSpaceCreation: preselected id wins when manageable", () => {
  const manageable = [workspace("a", "owner"), workspace("b", "admin")];
  assert.equal(selectWorkspaceForSpaceCreation(manageable, null, "b")?.id, "b");
  assert.equal(selectWorkspaceForSpaceCreation(manageable, manageable[0], "b")?.id, "b");
});

test("selectWorkspaceForSpaceCreation: falls back to active, then first manageable", () => {
  const manageable = [workspace("a", "owner"), workspace("b", "admin")];
  assert.equal(selectWorkspaceForSpaceCreation(manageable, manageable[1], null)?.id, "b");
  assert.equal(selectWorkspaceForSpaceCreation(manageable, workspace("x", "member"), "x")?.id, "a");
  assert.equal(selectWorkspaceForSpaceCreation([], null, null), null);
});
