const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/meetingFolderLabel.ts");

const t = (key) =>
  ({
    "meetingNotification.folders.private": "Private",
    "meetingNotification.folders.shared": "Shared",
    "notes.folders.defaults.meetings": "Réunions",
  })[key] ?? key;

const folder = (id, overrides = {}) => ({
  id,
  name: `Folder ${id}`,
  is_default: 0,
  space_id: 1,
  parent_folder_id: null,
  ...overrides,
});

const context = (folders) => ({
  spaces: [
    { id: 1, kind: "private", name: "Personal" },
    { id: 2, kind: "team", name: "Engineering" },
  ],
  folders,
  defaultDestination: null,
  selectedDestination: null,
  recentDestinations: [],
  existingNote: null,
});

test("a private folder reads as Private / Folder", async () => {
  const { meetingFolderLabel } = await load();
  const meetings = folder(1, { name: "Meetings", is_default: 1 });

  assert.equal(meetingFolderLabel(context([meetings]), meetings, t), "Private / Réunions");
});

test("a subfolder names its parent, and a team space is marked shared", async () => {
  const { meetingFolderLabel } = await load();
  const meetings = folder(1, { name: "Meetings", is_default: 1 });
  const client = folder(2, { name: "Client A", parent_folder_id: 1 });
  const teamParent = folder(3, { name: "Calls", space_id: 2 });
  const teamChild = folder(4, { name: "Q1", space_id: 2, parent_folder_id: 3 });
  const destinations = context([meetings, client, teamParent, teamChild]);

  assert.equal(meetingFolderLabel(destinations, client, t), "Private / Réunions / Client A");
  assert.equal(meetingFolderLabel(destinations, teamChild, t), "Engineering / Calls / Q1 · Shared");
});

test("a subfolder whose parent isn't a destination reads as top level", async () => {
  const { meetingFolderLabel } = await load();
  const orphan = folder(2, { name: "Client A", parent_folder_id: 1 });

  assert.equal(meetingFolderLabel(context([orphan]), orphan, t), "Private / Client A");
});

test("location labels without a folder name only the space", async () => {
  const { meetingLocationLabel } = await load();

  assert.equal(meetingLocationLabel(false, "Personal", null, t), "Private");
  assert.equal(meetingLocationLabel(true, "Engineering", null, t), "Engineering · Shared");
});
