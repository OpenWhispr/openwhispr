const test = require("node:test");
const assert = require("node:assert/strict");
const {
  privateSectionDropTarget,
  privateSectionFolders,
  privateSectionSpaces,
  privateSectionTarget,
} = require("../../src/lib/privateSection.ts");

const own = { id: 1, kind: "private", workspace_id: "a" };
const pending = { id: 9, kind: "private", workspace_id: null };
const team = { id: 2, kind: "team", workspace_id: "a" };
const folder = (id, spaceId, name, isDefault = 0) => ({
  id,
  space_id: spaceId,
  name,
  is_default: isDefault,
});

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

// The section's rows: "Plans" (10 in the workspace's own Private, 90 in the pending one), "Ideas"
// (pending only), "Notes" (own only) and the defaults, Meetings in both.
const sectionFolders = [
  folder(10, 1, "Plans"),
  folder(90, 9, "Plans"),
  folder(91, 9, "Ideas"),
  folder(12, 1, "Notes"),
  folder(11, 1, "Meetings", 1),
  folder(92, 9, "Meetings", 1),
  folder(20, 2, "Team folder"),
];
const section = [own, pending];

test("privateSectionTarget: a section row takes a note from either Private to its own", () => {
  const target = (noteSpaceId, spaceId, folderId) =>
    privateSectionTarget(section, sectionFolders, noteSpaceId, { spaceId, folderId });
  // The "Plans" row is the own Private's folder; a pending note lands in the pending "Plans".
  assert.deepEqual(target(9, 1, 10), { spaceId: 9, folderId: 90 });
  assert.deepEqual(target(1, 1, 10), { spaceId: 1, folderId: 10 });
  // The section itself is the note's own root.
  assert.deepEqual(target(9, 1, null), { spaceId: 9, folderId: null });
  // A row its own Private has no folder for is a move between the section's Privates.
  assert.deepEqual(target(9, 1, 12), { spaceId: 1, folderId: 12 });
  assert.deepEqual(target(1, 9, 91), { spaceId: 9, folderId: 91 });
  // Notes from outside the section, and rows outside it, land where the row points.
  assert.deepEqual(target(2, 1, 10), { spaceId: 1, folderId: 10 });
  assert.deepEqual(target(9, 2, 20), { spaceId: 2, folderId: 20 });
});

test("a drop onto a merged same-name Private folder from the other row is a no-op", () => {
  // The pending note already sits in its own "Plans": the row stands for that folder.
  const note = { spaceId: 9, folderId: 90 };
  const landing = privateSectionDropTarget(section, sectionFolders, note.spaceId, {
    spaceId: 1,
    folderId: 10,
  });
  assert.deepEqual(landing, { spaceId: note.spaceId, folderId: note.folderId });
  // And the section header holds a root note where it is.
  assert.deepEqual(
    privateSectionDropTarget(section, sectionFolders, 9, { spaceId: 1, folderId: null }),
    {
      spaceId: 9,
      folderId: null,
    }
  );
});

test("own Meetings is refused for both rows of the Private section", () => {
  // The Meetings row is the own Private's; it is the note's own Meetings from either Private.
  assert.equal(
    privateSectionDropTarget(section, sectionFolders, 1, { spaceId: 1, folderId: 11 }),
    null
  );
  assert.equal(
    privateSectionDropTarget(section, sectionFolders, 9, { spaceId: 1, folderId: 11 }),
    null
  );
  // Even when the note's own Private has no Meetings folder yet.
  const ownMeetingsOnly = sectionFolders.filter((f) => f.id !== 92);
  assert.equal(
    privateSectionDropTarget(section, ownMeetingsOnly, 9, { spaceId: 1, folderId: 11 }),
    null
  );
  // A teamspace note may still be copied into it.
  assert.deepEqual(
    privateSectionDropTarget(section, sectionFolders, 2, { spaceId: 1, folderId: 11 }),
    {
      spaceId: 1,
      folderId: 11,
    }
  );
});
