const test = require("node:test");
const assert = require("node:assert/strict");

const { buildNotePlacements } = require("../../src/helpers/notePlacement");

const unboundPrivate = { id: 1, kind: "private", name: "Personal", workspace_id: null };
const privateIn = (id, workspace_id) => ({ id, kind: "private", name: "Personal", workspace_id });
const team = (id, name, workspace_id = "w-acme-1111") => ({
  id,
  kind: "team",
  name,
  workspace_id,
});
const folder = (id, name, space_id, account_id = null) => ({ id, name, space_id, account_id });

const placements = (containers) =>
  buildNotePlacements({
    spaces: [unboundPrivate],
    folders: [],
    workspaceNames: { "w-acme-1111": "Acme", "w-beta-2222": "Beta" },
    ...containers,
  });

test("a private space bound to a workspace sits in that workspace's Private section", () => {
  const result = placements({
    spaces: [privateIn(5, "w-acme-1111")],
    folders: [folder(50, "Meetings", 5)],
  });

  assert.deepEqual(result.forNote({ folder_id: 50, space_id: 5 }), {
    segments: ["Workspaces", "Acme", "Private", "Meetings"],
    workspace: "Acme",
    space: "Private",
    folder: "Meetings",
  });
  assert.deepEqual(result.forNote({ folder_id: null, space_id: 5 }), {
    segments: ["Workspaces", "Acme", "Private"],
    workspace: "Acme",
    space: "Private",
  });
});

test("a private space with no workspace yet sits in Private notes", () => {
  const result = placements({ folders: [folder(10, "Meetings", 1)] });

  assert.deepEqual(result.forNote({ folder_id: 10, space_id: 1 }), {
    segments: ["Private notes", "Meetings"],
    space: "Private",
    folder: "Meetings",
  });
  assert.deepEqual(result.forNote({ folder_id: null, space_id: null }).segments, ["Private notes"]);
});

test("a team note sits under its workspace's Teamspaces", () => {
  const result = placements({
    spaces: [unboundPrivate, team(2, "Engineering")],
    folders: [folder(10, "General", 2)],
  });

  assert.deepEqual(result.forNote({ folder_id: 10, space_id: 2 }), {
    segments: ["Workspaces", "Acme", "Teamspaces", "Engineering", "General"],
    workspace: "Acme",
    space: "Engineering",
    folder: "General",
  });
  assert.deepEqual(result.forNote({ folder_id: null, space_id: 2 }).segments, [
    "Workspaces",
    "Acme",
    "Teamspaces",
    "Engineering",
  ]);
});

test("a teamspace named Private never merges with the Private section", () => {
  const result = placements({
    spaces: [privateIn(5, "w-acme-1111"), team(2, "Private")],
  });

  assert.deepEqual(result.forNote({ folder_id: null, space_id: 2 }).segments, [
    "Workspaces",
    "Acme",
    "Teamspaces",
    "Private",
  ]);
  assert.deepEqual(result.forNote({ folder_id: null, space_id: 5 }).segments, [
    "Workspaces",
    "Acme",
    "Private",
  ]);
});

test("a folder that no longer exists leaves the note at its space's root", () => {
  const result = placements({ spaces: [unboundPrivate, team(2, "Engineering")] });

  assert.deepEqual(result.forNote({ folder_id: 999, space_id: 2 }).segments, [
    "Workspaces",
    "Acme",
    "Teamspaces",
    "Engineering",
  ]);
});

test("a workspace whose name isn't known yet uses its id", () => {
  const result = placements({
    spaces: [unboundPrivate, team(2, "Engineering", "w-gamma-3333")],
  });

  const placement = result.forNote({ folder_id: null, space_id: 2 });
  assert.deepEqual(placement.segments, [
    "Workspaces",
    "Workspace w-gamma-",
    "Teamspaces",
    "Engineering",
  ]);
  assert.equal(placement.workspace, undefined, "frontmatter never claims a made-up name");
});

test("a team space with no workspace goes under Other spaces", () => {
  const result = placements({ spaces: [unboundPrivate, team(2, "Old team", null)] });

  const placement = result.forNote({ folder_id: null, space_id: 2 });
  assert.deepEqual(placement.segments, ["Workspaces", "Other spaces", "Teamspaces", "Old team"]);
  assert.equal(placement.workspace, undefined);
});

test("a note in a space this device doesn't have never lands in a Private section", () => {
  assert.deepEqual(placements().forNote({ folder_id: null, space_id: 42 }).segments, [
    "Workspaces",
    "Other spaces",
    "Teamspaces",
    "Space 42",
  ]);
});

test("same-named workspaces, spaces and folders stay apart, ignoring case", () => {
  const result = placements({
    workspaceNames: { "w-acme-1111": "Acme", "w-beta-2222": "ACME" },
    spaces: [unboundPrivate, team(2, "Eng"), team(3, "eng"), team(4, "Eng", "w-beta-2222")],
    folders: [folder(10, "General", 2), folder(11, "general", 2)],
  });

  assert.deepEqual(result.forNote({ folder_id: 10, space_id: 2 }).segments.slice(1), [
    "Acme",
    "Teamspaces",
    "Eng",
    "General",
  ]);
  assert.deepEqual(result.forNote({ folder_id: 11, space_id: 2 }).segments.slice(1), [
    "Acme",
    "Teamspaces",
    "Eng",
    "general (11)",
  ]);
  assert.deepEqual(result.forNote({ folder_id: null, space_id: 3 }).segments.slice(1), [
    "Acme",
    "Teamspaces",
    "eng (3)",
  ]);
  assert.deepEqual(result.forNote({ folder_id: null, space_id: 4 }).segments.slice(1), [
    "ACME (w-beta)",
    "Teamspaces",
    "Eng",
  ]);
  assert.equal(result.forNote({ folder_id: 11, space_id: 2 }).folder, "general");
});

test("a workspace called Other spaces doesn't merge with spaces that have no workspace", () => {
  const result = placements({
    workspaceNames: { "w-acme-1111": "Other spaces" },
    spaces: [unboundPrivate, team(2, "Old team", null), team(3, "New team")],
  });

  assert.deepEqual(result.forNote({ folder_id: null, space_id: 2 }).segments[1], "Other spaces");
  assert.deepEqual(
    result.forNote({ folder_id: null, space_id: 3 }).segments[1],
    "Other spaces (w-acme)"
  );
});

test("two accounts' Private sections in one workspace share a directory", () => {
  const result = placements({
    spaces: [privateIn(5, "w-acme-1111"), privateIn(6, "w-acme-1111")],
    folders: [folder(50, "Meetings", 5, "a1"), folder(60, "Meetings", 6, "a2")],
  });

  assert.deepEqual(
    result.forNote({ folder_id: 50, space_id: 5 }).segments,
    result.forNote({ folder_id: 60, space_id: 6 }).segments
  );
});

test("every folder is listed with its location", () => {
  const result = placements({
    spaces: [unboundPrivate, team(2, "Engineering")],
    folders: [folder(10, "General", 2)],
  });

  assert.deepEqual(result.folderLocation(10).segments, [
    "Workspaces",
    "Acme",
    "Teamspaces",
    "Engineering",
    "General",
  ]);
  assert.equal(result.folderLocation(999), null);
  assert.deepEqual(
    result.folderLocations().map((location) => location.folder),
    ["General"]
  );
});

test("a suffixed name never lands on another folder's name", () => {
  const result = placements({
    folders: [folder(1, "Notes", 1), folder(2, "notes", 1), folder(3, "Notes (2)", 1)],
  });

  const dirs = [1, 2, 3].map((id) =>
    result.forNote({ folder_id: id, space_id: 1 }).segments.at(-1).toLowerCase()
  );
  assert.equal(new Set(dirs).size, 3);
});

test("two accounts' folders differing only in case get their own directories", () => {
  const result = placements({
    spaces: [unboundPrivate, privateIn(5, "w-acme-1111"), privateIn(6, "w-acme-1111")],
    folders: [
      folder(10, "Work", 1, "a1"),
      folder(11, "work", 1, "a2"),
      folder(12, "Work", 1, "a3"),
      folder(50, "Meetings", 5, "a1"),
      folder(60, "meetings", 6, "a2"),
    ],
  });
  const dirOf = (folderId, spaceId) =>
    result.forNote({ folder_id: folderId, space_id: spaceId }).segments.join("/");

  assert.notEqual(dirOf(10, 1).toLowerCase(), dirOf(11, 1).toLowerCase());
  assert.equal(dirOf(10, 1), dirOf(12, 1), "the very same name still shares");
  assert.notEqual(dirOf(50, 5).toLowerCase(), dirOf(60, 6).toLowerCase());
});
