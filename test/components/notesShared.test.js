const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/components/notes/shared.ts");

test("folder scopes get the folder-specific empty title", async () => {
  const { notesEmptyTitleKey } = await load();

  assert.equal(notesEmptyTitleKey(true), "notes.empty.emptyFolder");
});

test("space roots keep the generic empty title", async () => {
  const { notesEmptyTitleKey } = await load();

  assert.equal(notesEmptyTitleKey(false), "notes.empty.title");
});

test("both empty-title keys resolve to strings in the en locale", async () => {
  const { notesEmptyTitleKey } = await load();
  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );

  for (const inFolder of [true, false]) {
    const key = notesEmptyTitleKey(inFolder);
    const value = key.split(".").reduce((node, part) => node?.[part], en);
    assert.equal(typeof value, "string", `missing en translation for ${key}`);
  }
});

const t = (key) => ({ "notes.folders.defaults.meetings": "الاجتماعات" })[key] ?? key;
const folder = (id, overrides = {}) => ({
  id,
  name: `Folder ${id}`,
  is_default: 0,
  space_id: 1,
  parent_folder_id: null,
  ...overrides,
});

test("tree order puts each subfolder right after its parent and keeps main's order", async () => {
  const { orderFoldersAsTree } = await load();
  const folders = [
    folder(5, { parent_folder_id: 2 }),
    folder(1),
    folder(2),
    folder(4, { parent_folder_id: 1 }),
    folder(3, { parent_folder_id: 2 }),
  ];

  assert.deepEqual(
    orderFoldersAsTree(folders).map((f) => f.id),
    [1, 4, 2, 5, 3]
  );
});

test("a subfolder whose parent isn't loaded in its space shows as top level", async () => {
  const { folderTree, orderFoldersAsTree } = await load();
  const folders = [
    folder(1),
    folder(2, { parent_folder_id: 99 }),
    folder(3, { parent_folder_id: 1, space_id: 2 }),
    folder(4, { parent_folder_id: 1 }),
  ];

  assert.deepEqual(
    orderFoldersAsTree(folders).map((f) => f.id),
    [1, 4, 2, 3]
  );
  assert.deepEqual(
    folderTree(folders).map(({ folder: f, subfolders }) => [f.id, subfolders.map((s) => s.id)]),
    [
      [1, [4]],
      [2, []],
      [3, []],
    ]
  );
});

test("a folder name clash says where the name is used, unless it's right beside this folder", async () => {
  const { folderMutationErrorDescription } = await load();
  const t = (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key);
  const meetings = folder(1, { name: "Meetings", is_default: 1 });
  const taken = "A folder with that name already exists";
  const plain = "notes.mutationErrors.folderAlreadyExists";
  const describe = (result, attempt) =>
    folderMutationErrorDescription({ error: taken, ...result }, [meetings], t, attempt);
  const atTopLevel = { takenName: "Q1", takenInFolderId: null };

  assert.match(
    describe({ takenName: "Q1", takenInFolderId: 1 }, { name: "Q1", nested: false }),
    /^notes\.mutationErrors\.folderNameTakenIn .*"name":"Q1".*"parent":"notes\.folders\.defaults\.meetings"/
  );
  assert.match(
    describe(atTopLevel, { name: "Q1", nested: true }),
    /^notes\.mutationErrors\.folderNameTakenTopLevel/
  );
  assert.match(
    describe(atTopLevel, { name: "Work", nested: false }),
    /^notes\.mutationErrors\.folderNameTakenTopLevel/
  );
  assert.equal(describe(atTopLevel, { name: "Q1", nested: false }), plain);
  assert.equal(
    describe({ takenName: "Q1", takenInFolderId: 99 }, { name: "Q1", nested: false }),
    plain
  );
  assert.equal(describe({}, undefined), plain);
  assert.equal(
    folderMutationErrorDescription({ error: "Folder not found" }, [], t),
    "notes.mutationErrors.folderNotFound"
  );
});

test("path labels name the parent and localize default folder segments", async () => {
  const { folderPathLabel } = await load();
  const meetings = folder(1, { name: "Meetings", is_default: 1 });
  const client = folder(2, { name: "Client A", parent_folder_id: 1 });
  const orphan = folder(3, { name: "Q1", parent_folder_id: 99 });
  const folders = [meetings, client, orphan];

  assert.equal(folderPathLabel(meetings, folders, t), "الاجتماعات");
  assert.equal(folderPathLabel(client, folders, t), "الاجتماعات / Client A");
  assert.equal(folderPathLabel(orphan, folders, t), "Q1");
});

test("URL downloads only route to a top-level Videos folder", async () => {
  const { findVideosFolder } = await load();
  const meetings = folder(1, { name: "Meetings", is_default: 1 });
  const nested = folder(2, { name: "Videos", parent_folder_id: 1 });
  const topLevel = folder(3, { name: "Videos" });

  assert.equal(findVideosFolder([meetings, nested]), undefined);
  assert.equal(findVideosFolder([meetings, nested, topLevel]), topLevel);
});
