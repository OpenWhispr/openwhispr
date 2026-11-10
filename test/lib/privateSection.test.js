const test = require("node:test");
const assert = require("node:assert/strict");
const { privateSectionFolders, privateSectionSpaces } = require("../../src/lib/privateSection.ts");

const own = { id: 1, kind: "private", workspace_id: "a" };
const pending = { id: 9, kind: "private", workspace_id: null };
const team = { id: 2, kind: "team", workspace_id: "a" };
const folder = (id, spaceId, name) => ({ id, space_id: spaceId, name });

test("privateSectionSpaces: the workspace's own Private first, then the pending one", () => {
  assert.deepEqual(
    privateSectionSpaces([pending, team, own]).map((s) => s.id),
    [1, 9]
  );
  assert.deepEqual(
    privateSectionSpaces([team, pending]).map((s) => s.id),
    [9]
  );
  assert.deepEqual(privateSectionSpaces([team]), []);
});

test("privateSectionFolders: folders sharing a name across the section's Privates are one row", () => {
  const folders = [
    folder(90, 9, "Personal"),
    folder(10, 1, "Personal"),
    folder(91, 9, "Ideas"),
    folder(11, 1, "Meetings"),
    folder(92, 9, "Meetings"),
    folder(20, 2, "Personal"),
  ];
  const groups = privateSectionFolders([own, pending], folders);
  assert.deepEqual(
    groups.map((g) => [g.folder.id, g.members.map((m) => m.id)]),
    [
      [10, [10, 90]],
      [11, [11, 92]],
      [91, [91]],
    ]
  );
});

test("privateSectionFolders: two folders of one name in the same Private stay two rows", () => {
  const groups = privateSectionFolders([own], [folder(10, 1, "Notes"), folder(12, 1, "Notes")]);
  assert.deepEqual(
    groups.map((g) => g.members.map((m) => m.id)),
    [[10], [12]]
  );
});
