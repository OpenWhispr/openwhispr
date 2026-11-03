const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decideNoteWorkspaceScope,
  isSpaceInWorkspaceScope,
  manageableWorkspaces,
  selectWorkspaceForSpaceCreation,
  spacesInWorkspaceScope,
} = require("../../src/lib/workspaceSelection.ts");

const workspace = (id, role) => ({ id, name: `Workspace ${id}`, role });

test("manageableWorkspaces: keeps only owner/admin workspaces, in order", () => {
  const member = workspace("m", "member");
  const admin = workspace("a", "admin");
  const owner = workspace("o", "owner");
  assert.deepEqual(manageableWorkspaces([member, admin, owner]), [admin, owner]);
  assert.deepEqual(manageableWorkspaces([member]), []);
});

test("manageableWorkspaces follows the create_spaces capability", () => {
  const blockedAdmin = { ...workspace("a", "admin"), capabilities: { create_spaces: false } };
  const grantedMember = { ...workspace("m", "member"), capabilities: { create_spaces: true } };
  assert.deepEqual(manageableWorkspaces([blockedAdmin, grantedMember]), [grantedMember]);
});

const personal = { id: 1, kind: "private", workspace_id: null };
const teamIn = (id, workspaceId) => ({ id, kind: "team", workspace_id: workspaceId });
const listed = [workspace("a", "member"), workspace("b", "member")];

test("isSpaceInWorkspaceScope: Personal and the active workspace's spaces show", () => {
  assert.equal(isSpaceInWorkspaceScope(personal, "a", listed), true);
  assert.equal(isSpaceInWorkspaceScope(teamIn(2, "a"), "a", listed), true);
  assert.equal(isSpaceInWorkspaceScope(teamIn(3, "b"), "a", listed), false);
});

test("isSpaceInWorkspaceScope: unlisted or workspace-less team spaces stay reachable", () => {
  assert.equal(isSpaceInWorkspaceScope(teamIn(2, null), "a", listed), true);
  assert.equal(isSpaceInWorkspaceScope(teamIn(3, "gone"), "a", listed), true);
  // Before the workspace list loads nothing is hidden.
  assert.equal(isSpaceInWorkspaceScope(teamIn(4, "b"), "a", []), true);
  // No active workspace (signed out, none yet): everything shows.
  assert.equal(isSpaceInWorkspaceScope(teamIn(5, "b"), null, listed), true);
  // An active id the list doesn't hold (left, not loaded yet) scopes nothing.
  assert.equal(isSpaceInWorkspaceScope(teamIn(6, "b"), "gone", listed), true);
});

test("spacesInWorkspaceScope keeps order and drops other workspaces' spaces", () => {
  const spaces = [teamIn(2, "b"), personal, teamIn(3, "a"), teamIn(4, null)];
  assert.deepEqual(
    spacesInWorkspaceScope(spaces, "a", listed).map((s) => s.id),
    [1, 3, 4]
  );
});

const decide = (overrides) =>
  decideNoteWorkspaceScope({
    reason: "workspaceSwitched",
    activeWorkspaceId: "a",
    workspaces: listed,
    contextSpace: null,
    noteSpace: null,
    ...overrides,
  });

test("decideNoteWorkspaceScope: nothing to do while everything shows", () => {
  assert.deepEqual(decide({ contextSpace: personal, noteSpace: teamIn(2, "a") }), {
    kind: "none",
  });
  assert.deepEqual(decide({ reason: "navigated", contextSpace: teamIn(2, "a") }), {
    kind: "none",
  });
});

test("decideNoteWorkspaceScope: a switch closes a hidden note and leaves its container", () => {
  assert.deepEqual(decide({ contextSpace: teamIn(3, "b"), noteSpace: teamIn(3, "b") }), {
    kind: "leaveHidden",
    clearNote: true,
    context: "default",
  });
  assert.deepEqual(decide({ contextSpace: teamIn(3, "b") }), {
    kind: "leaveHidden",
    clearNote: false,
    context: "default",
  });
});

test("decideNoteWorkspaceScope: a switch keeps a visible note and moves the container to it", () => {
  assert.deepEqual(decide({ contextSpace: teamIn(3, "b"), noteSpace: personal }), {
    kind: "leaveHidden",
    clearNote: false,
    context: "note",
  });
  assert.deepEqual(decide({ contextSpace: personal, noteSpace: teamIn(3, "b") }), {
    kind: "leaveHidden",
    clearNote: true,
    context: "keep",
  });
});

test("decideNoteWorkspaceScope: opening another workspace's space or note switches to it", () => {
  assert.deepEqual(decide({ reason: "navigated", contextSpace: teamIn(3, "b") }), {
    kind: "enterWorkspace",
    workspaceId: "b",
  });
  // A search result sets the folder before the note: the moved container
  // wins over the note still open from before.
  assert.deepEqual(
    decide({ reason: "navigated", contextSpace: teamIn(3, "b"), noteSpace: personal }),
    { kind: "enterWorkspace", workspaceId: "b" }
  );
  // The note wins when the note and its container disagree.
  assert.deepEqual(
    decide({
      reason: "navigated",
      workspaces: [...listed, workspace("c", "member")],
      contextSpace: teamIn(3, "b"),
      noteSpace: teamIn(4, "c"),
    }),
    { kind: "enterWorkspace", workspaceId: "c" }
  );
});

test("decideNoteWorkspaceScope: data changing under the open note never switches", () => {
  // A sync or an undone move put the open Personal note into B's teamspace.
  assert.deepEqual(
    decide({ reason: "dataChanged", contextSpace: personal, noteSpace: teamIn(3, "b") }),
    {
      kind: "leaveHidden",
      clearNote: true,
      context: "keep",
    }
  );
  assert.deepEqual(decide({ reason: "dataChanged", contextSpace: teamIn(3, "b") }), {
    kind: "leaveHidden",
    clearNote: false,
    context: "default",
  });
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
