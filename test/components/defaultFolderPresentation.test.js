const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/notes/shared.ts");

const labels = {
  en: {
    "notes.folders.defaults.personal": "Personal",
    "notes.folders.defaults.meetings": "Meetings",
    "notes.folders.defaults.videos": "Videos",
  },
  ar: {
    "notes.folders.defaults.personal": "شخصي",
    "notes.folders.defaults.meetings": "الاجتماعات",
    "notes.folders.defaults.videos": "الفيديوهات",
  },
};

const translator = (locale) => (key) => labels[locale][key] ?? key;

test("canonical default folders use the active Arabic presentation labels", async () => {
  const { defaultFolderDisplayName } = await load();
  const folders = ["Personal", "Meetings", "Videos"].map((name) => ({
    name,
    is_default: 1,
  }));

  assert.deepEqual(
    folders.map((folder) => defaultFolderDisplayName(folder, translator("ar"))),
    ["شخصي", "الاجتماعات", "الفيديوهات"]
  );
});

test("canonical default folders retain their normal English presentation labels", async () => {
  const { defaultFolderDisplayName } = await load();
  const folders = ["Personal", "Meetings", "Videos"].map((name) => ({
    name,
    is_default: true,
  }));

  assert.deepEqual(
    folders.map((folder) => defaultFolderDisplayName(folder, translator("en"))),
    ["Personal", "Meetings", "Videos"]
  );
});

test("changing locale changes presentation without mutating the stored folder name", async () => {
  const { defaultFolderDisplayName } = await load();
  const folder = { name: "Personal", is_default: 1 };

  assert.equal(defaultFolderDisplayName(folder, translator("en")), "Personal");
  assert.equal(defaultFolderDisplayName(folder, translator("ar")), "شخصي");
  assert.deepEqual(folder, { name: "Personal", is_default: 1 });
});

test("user-authored and non-canonical folder names are displayed verbatim", async () => {
  const { defaultFolderDisplayName } = await load();
  const folders = [
    { name: "Personal", is_default: 0 },
    { name: "Client Work", is_default: false },
    { name: "مشاريعي", is_default: false },
    { name: "Archive", is_default: true },
  ];

  assert.deepEqual(
    folders.map((folder) => defaultFolderDisplayName(folder, translator("ar"))),
    ["Personal", "Client Work", "مشاريعي", "Archive"]
  );
});
