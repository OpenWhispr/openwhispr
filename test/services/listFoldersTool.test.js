const test = require("node:test");
const assert = require("node:assert/strict");

test.afterEach(() => {
  delete global.window;
});

test("list_folders names each subfolder's parent", async () => {
  global.window = {
    electronAPI: {
      getFolders: async () => [
        { id: 1, name: "Client A", space_id: 1, parent_folder_id: null },
        { id: 2, name: "Q1", space_id: 1, parent_folder_id: 1 },
      ],
      getSpaces: async () => [{ id: 1, name: "Personal", kind: "private" }],
    },
  };
  const { listFoldersTool } = await import("../../src/services/tools/listFoldersTool.ts");

  const result = await listFoldersTool.execute({});
  assert.deepEqual(result.data, [
    { id: 1, name: "Client A", parent: null, space: "Personal" },
    { id: 2, name: "Q1", parent: "Client A", space: "Personal" },
  ]);
  assert.equal(result.displayText, "Folders: Client A, Client A / Q1");
});
