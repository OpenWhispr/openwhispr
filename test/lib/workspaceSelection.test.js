const test = require("node:test");
const assert = require("node:assert/strict");
const {
  activePrivateSpace,
  assistantScopeSpaceIds,
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

// A private space belongs to one workspace; the pending one (no workspace yet, or signed out
// the stand-in) is the default workspace's until main binds it.
const privateOf = (id, workspaceId) => ({ id, kind: "private", workspace_id: workspaceId });
const privateA = privateOf(1, "a");
const pending = privateOf(9, null);
const teamIn = (id, workspaceId) => ({ id, kind: "team", workspace_id: workspaceId });
const listed = [workspace("a", "member"), workspace("b", "member")];

test("isSpaceInWorkspaceScope: the active workspace's Private and spaces show", () => {
  assert.equal(isSpaceInWorkspaceScope(privateA, "a", listed, "a"), true);
  assert.equal(isSpaceInWorkspaceScope(teamIn(2, "a"), "a", listed, "a"), true);
  assert.equal(isSpaceInWorkspaceScope(teamIn(3, "b"), "a", listed, "a"), false);
});

test("isSpaceInWorkspaceScope: unlisted or workspace-less team spaces stay reachable", () => {
  assert.equal(isSpaceInWorkspaceScope(teamIn(2, null), "a", listed, "a"), true);
  assert.equal(isSpaceInWorkspaceScope(teamIn(3, "gone"), "a", listed, "a"), true);
  // Before the workspace list loads nothing is hidden.
  assert.equal(isSpaceInWorkspaceScope(teamIn(4, "b"), "a", [], null), true);
  // No active workspace (signed out, none yet): everything shows.
  assert.equal(isSpaceInWorkspaceScope(teamIn(5, "b"), null, listed, "a"), true);
  // An active id the list doesn't hold (left, not loaded yet) scopes nothing.
  assert.equal(isSpaceInWorkspaceScope(teamIn(6, "b"), "gone", listed, "a"), true);
});

test("a private space shows only in its own workspace", () => {
  assert.equal(isSpaceInWorkspaceScope(privateOf(2, "b"), "a", listed, "a"), false);
  assert.equal(isSpaceInWorkspaceScope(privateA, "b", listed, "a"), false);
  assert.equal(isSpaceInWorkspaceScope(privateOf(2, "b"), "b", listed, "a"), true);
  // A workspace the list no longer holds (lost, its Private not moved yet) still keeps it.
  assert.equal(isSpaceInWorkspaceScope(privateOf(3, "gone"), "a", listed, "a"), false);
  // Not even an active id the list doesn't hold opens every Private.
  assert.equal(isSpaceInWorkspaceScope(privateOf(2, "b"), "gone", listed, "a"), false);
});

test("the pending private space shows in the default workspace", () => {
  assert.equal(isSpaceInWorkspaceScope(pending, "a", listed, "a"), true);
  assert.equal(isSpaceInWorkspaceScope(pending, "b", listed, "a"), false);
});

test("signed out, the stand-in Private shows", () => {
  // No account: no workspaces, and no active or default workspace.
  assert.equal(isSpaceInWorkspaceScope(pending, null, [], null), true);
  // An active id another window left in storage doesn't hide it.
  assert.equal(isSpaceInWorkspaceScope(pending, "a", [], null), true);
});

test("while the default workspace isn't known, the pending Private shows and no other workspace's does", () => {
  // The list is loading: the workspace saved as active, no default yet.
  assert.equal(isSpaceInWorkspaceScope(privateA, "a", [], null), true);
  assert.equal(isSpaceInWorkspaceScope(pending, "a", [], null), true);
  assert.equal(isSpaceInWorkspaceScope(privateOf(2, "b"), "a", [], null), false);
  // The default's own row is another workspace's Private like any other.
  assert.equal(
    isSpaceInWorkspaceScope({ ...privateOf(3, "d"), is_default_private: 1 }, "a", [], null),
    false
  );
});

test("spacesInWorkspaceScope keeps order and drops other workspaces' spaces", () => {
  const spaces = [teamIn(2, "b"), privateA, teamIn(3, "a"), privateOf(5, "b"), teamIn(4, null)];
  assert.deepEqual(
    spacesInWorkspaceScope(spaces, "a", listed, "a").map((s) => s.id),
    [1, 3, 4]
  );
});

test("activePrivateSpace: the active workspace's own Private comes before the pending one", () => {
  const scoped = spacesInWorkspaceScope([pending, teamIn(2, "a"), privateA], "a", listed, "a");
  assert.equal(activePrivateSpace(scoped), privateA);
  assert.equal(activePrivateSpace([teamIn(2, "a"), pending]), pending);
  assert.equal(activePrivateSpace([teamIn(2, "a")]), null);
});

// What the assistant may read: every space of workspace A's scope, none of workspace B's.
const assistantSpaces = [
  privateA,
  pending,
  privateOf(5, "b"),
  teamIn(2, "a"),
  teamIn(3, "b"),
  teamIn(6, null),
  teamIn(7, "gone"),
];
const assistantScope = (overrides) =>
  assistantScopeSpaceIds({
    spaces: assistantSpaces,
    activeWorkspaceId: "a",
    workspaces: listed,
    defaultWorkspaceId: "a",
    privateSpaceId: 1,
    defaultPrivateSpaceId: 1,
    ...overrides,
  }).sort((x, y) => x - y);

test("assistantScopeSpaceIds: with the workspace list, the assistant reads what the tree shows", () => {
  assert.deepEqual(assistantScope(), [1, 2, 6, 7, 9]);
  // Workspace B active: its own Private and teamspace, never A's Private or the default's pending one.
  assert.deepEqual(assistantScope({ activeWorkspaceId: "b", privateSpaceId: 5 }), [3, 5, 6, 7]);
});

test("assistantScopeSpaceIds: without the workspace list (the dictation window), main's Private and the active workspace's teamspaces", () => {
  // Main's Private is the default's, so the pending one (merged into it in the tree) counts too.
  assert.deepEqual(assistantScope({ workspaces: [], defaultWorkspaceId: null }), [1, 2, 6, 9]);
  // Main's Private isn't the default's: the default's pending notes belong to another workspace.
  assert.deepEqual(
    assistantScope({
      activeWorkspaceId: "b",
      workspaces: [],
      defaultWorkspaceId: null,
      privateSpaceId: 5,
      defaultPrivateSpaceId: 1,
    }),
    [3, 5, 6]
  );
  // A list that doesn't hold the active workspace (just left, still loading) is no list at all,
  // and main's Private, still A's, isn't the active workspace's.
  assert.deepEqual(
    assistantScope({ activeWorkspaceId: "gone", privateSpaceId: 1, defaultPrivateSpaceId: 1 }),
    [6, 7]
  );
});

test("assistantScopeSpaceIds: a Private main names for another workspace never counts", () => {
  // Main's workspace scope lags (startup, an account change): it still names the default
  // workspace D's Private while workspace A is active and no list has loaded.
  const lagging = {
    spaces: [privateA, privateOf(5, "d"), teamIn(2, "a"), pending],
    workspaces: [],
    defaultWorkspaceId: null,
    privateSpaceId: 5,
    defaultPrivateSpaceId: 5,
  };
  // A's own Private and teamspace, never D's Private or D's pending notes.
  assert.deepEqual(assistantScope(lagging), [1, 2]);
  // Nothing of A's own yet: still nothing of D's.
  assert.deepEqual(
    assistantScope({ ...lagging, spaces: [privateOf(5, "d"), teamIn(2, "a")] }),
    [2]
  );
  // Main's Private is A's own and A is the default: the pending one merges in, as in the tree.
  assert.deepEqual(
    assistantScope({ ...lagging, privateSpaceId: 1, defaultPrivateSpaceId: 1 }),
    [1, 2, 9]
  );
  // Main's Private is the pending row itself (no default bound yet): it is the active Private.
  assert.deepEqual(
    assistantScope({
      ...lagging,
      spaces: [pending, teamIn(2, "a")],
      privateSpaceId: 9,
      defaultPrivateSpaceId: 9,
    }),
    [2, 9]
  );
  // A Private main names that isn't among the spaces can't be checked: left out.
  assert.deepEqual(
    assistantScope({
      ...lagging,
      spaces: [teamIn(2, "a")],
      privateSpaceId: 1,
      defaultPrivateSpaceId: 1,
    }),
    [2]
  );
});

test("assistantScopeSpaceIds fails closed to main's Private when no workspace is active", () => {
  assert.deepEqual(assistantScope({ activeWorkspaceId: null }), [1]);
  assert.deepEqual(assistantScope({ activeWorkspaceId: null, workspaces: [] }), [1]);
  // Not even main's Private is known: nothing.
  assert.deepEqual(assistantScope({ activeWorkspaceId: null, privateSpaceId: null }), []);
});

const decide = (overrides) =>
  decideNoteWorkspaceScope({
    reason: "workspaceSwitched",
    activeWorkspaceId: "a",
    workspaces: listed,
    defaultWorkspaceId: "a",
    contextSpace: null,
    noteSpace: null,
    ...overrides,
  });

test("decideNoteWorkspaceScope: nothing to do while everything shows", () => {
  assert.deepEqual(decide({ contextSpace: privateA, noteSpace: teamIn(2, "a") }), {
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
  // Another workspace's Private, too.
  assert.deepEqual(decide({ contextSpace: privateOf(2, "b"), noteSpace: privateOf(2, "b") }), {
    kind: "leaveHidden",
    clearNote: true,
    context: "default",
  });
});

test("decideNoteWorkspaceScope: a switch keeps a visible note and moves the container to it", () => {
  assert.deepEqual(decide({ contextSpace: teamIn(3, "b"), noteSpace: privateA }), {
    kind: "leaveHidden",
    clearNote: false,
    context: "note",
  });
  assert.deepEqual(decide({ contextSpace: privateA, noteSpace: teamIn(3, "b") }), {
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
    decide({ reason: "navigated", contextSpace: teamIn(3, "b"), noteSpace: privateA }),
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

test("opening a private note of another workspace enters that workspace", () => {
  assert.deepEqual(
    decide({ reason: "navigated", contextSpace: privateA, noteSpace: privateOf(2, "b") }),
    { kind: "enterWorkspace", workspaceId: "b" }
  );
  assert.deepEqual(decide({ reason: "navigated", contextSpace: privateOf(2, "b") }), {
    kind: "enterWorkspace",
    workspaceId: "b",
  });
  // Before the list loads, the workspace the note names is entered; the list then keeps it or
  // replaces it.
  assert.deepEqual(
    decide({
      reason: "navigated",
      workspaces: [],
      defaultWorkspaceId: null,
      noteSpace: privateOf(2, "b"),
    }),
    { kind: "enterWorkspace", workspaceId: "b" }
  );
});

test("decideNoteWorkspaceScope: a private note of a workspace no longer listed never switches", () => {
  // Its Private moves to the default's once the loss is handled; entering the lost workspace would
  // leave the switcher on nothing it lists.
  assert.deepEqual(decide({ reason: "navigated", noteSpace: privateOf(3, "gone") }), {
    kind: "leaveHidden",
    clearNote: true,
    context: "keep",
  });
});

test("decideNoteWorkspaceScope: opening a pending private note from another workspace enters the default", () => {
  // The pending Private is the default workspace's until main binds it.
  assert.deepEqual(decide({ reason: "navigated", activeWorkspaceId: "b", noteSpace: pending }), {
    kind: "enterWorkspace",
    workspaceId: "a",
  });
  assert.deepEqual(decide({ reason: "navigated", activeWorkspaceId: "b", contextSpace: pending }), {
    kind: "enterWorkspace",
    workspaceId: "a",
  });
});

test("decideNoteWorkspaceScope: data changing under the open note never switches", () => {
  // A sync or an undone move put the open private note into B's teamspace.
  assert.deepEqual(
    decide({ reason: "dataChanged", contextSpace: privateA, noteSpace: teamIn(3, "b") }),
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
