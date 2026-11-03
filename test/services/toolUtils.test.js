const test = require("node:test");
const assert = require("node:assert/strict");

test.afterEach(() => {
  delete global.window;
});

const load = () => import("../../src/services/tools/utils.ts");

test("cloud UUIDs resolve through the local client-id lookup without numeric parsing", async () => {
  const { resolveLocalNoteId } = await load();
  const seen = [];
  const id = await resolveLocalNoteId("3a4f8b9c-uuid", async (clientNoteId) => {
    seen.push(clientNoteId);
    return { id: 42, deleted_at: null };
  });

  assert.equal(id, 42);
  assert.deepEqual(seen, ["3a4f8b9c-uuid"]);
});

test("unavailable, deleted, invalid, and failed local rows produce no clickable id", async () => {
  const { resolveLocalNoteId } = await load();

  assert.equal(await resolveLocalNoteId(null, async () => ({ id: 1 })), null);
  assert.equal(await resolveLocalNoteId("uuid", undefined), null);
  assert.equal(await resolveLocalNoteId("uuid", async () => null), null);
  assert.equal(
    await resolveLocalNoteId("uuid", async () => ({ id: 7, deleted_at: "2026-07-28" })),
    null
  );
  assert.equal(await resolveLocalNoteId("uuid", async () => ({ id: Number.NaN })), null);
  assert.equal(
    await resolveLocalNoteId("uuid", async () => {
      throw new Error("database unavailable");
    }),
    null
  );
});

test("resolveFolderId normalizes whitespace and matches existing folders case-insensitively", async () => {
  const { resolveFolderId } = await load();
  global.window = {
    electronAPI: {
      getFolders: async () => [{ id: 10, name: "Work" }],
      createFolder: async () => ({ success: true, folder: { id: 20, name: "NewFolder" } }),
    },
  };

  const match = await resolveFolderId("  work  ");
  assert.deepEqual(match, { folderId: 10, created: false });
});

test("resolveFolderId trims folder name before creating missing folders", async () => {
  const { resolveFolderId } = await load();
  let createdName = null;
  global.window = {
    electronAPI: {
      getFolders: async () => [],
      createFolder: async (name) => {
        createdName = name;
        return { success: true, folder: { id: 15, name } };
      },
    },
  };

  const res = await resolveFolderId("  Projects  ", { createIfMissing: true });
  assert.deepEqual(res, { folderId: 15, created: true });
  assert.equal(createdName, "Projects");
});

// A subfolder's name and label, as list_folders shows them.
const CLIENT_A = { id: 1, name: "Client A", space_id: 3, parent_folder_id: null };
const Q1 = { id: 2, name: "Q1", space_id: 3, parent_folder_id: 1 };

function stubFolders(folders) {
  const created = [];
  global.window = {
    electronAPI: {
      getFolders: async () => folders,
      createFolder: async (...args) => {
        created.push(args);
        return { success: true, folder: { id: 50, name: args[0] } };
      },
    },
  };
  return created;
}

test("resolveFolderId matches a subfolder by its plain name or its label, in any case", async () => {
  const { resolveFolderId } = await load();
  const created = stubFolders([CLIENT_A, Q1]);

  for (const name of ["Q1", "Client A / Q1", "client a / q1"]) {
    assert.deepEqual(await resolveFolderId(name, { createIfMissing: true }, 3), {
      folderId: 2,
      created: false,
    });
  }
  assert.deepEqual(created, []);
});

test("resolveFolderId prefers a folder literally named like a label", async () => {
  const { resolveFolderId } = await load();
  stubFolders([
    CLIENT_A,
    Q1,
    { id: 9, name: "Client A / Q1", space_id: 3, parent_folder_id: null },
  ]);

  assert.deepEqual(await resolveFolderId("Client A / Q1", {}, 3), { folderId: 9, created: false });
});

test("resolveFolderId creates a labelled subfolder under its existing parent", async () => {
  const { resolveFolderId } = await load();
  const created = stubFolders([CLIENT_A, Q1]);

  assert.deepEqual(await resolveFolderId("client a / Q2", { createIfMissing: true }, 3), {
    folderId: 50,
    created: true,
  });
  assert.deepEqual(created, [["Q2", 3, 1]]);
});

for (const [why, name] of [
  ["the parent doesn't exist", "Client B / Q1"],
  ["the parent is itself a subfolder", "Client A / Q1 / January"],
]) {
  test(`resolveFolderId creates nothing and lists folders by label when ${why}`, async () => {
    const { resolveFolderId } = await load();
    const created = stubFolders([CLIENT_A, Q1]);

    assert.deepEqual(await resolveFolderId(name, { createIfMissing: true }, 3), {
      error: `Folder "${name}" not found. Available folders: Client A, Client A / Q1`,
    });
    assert.deepEqual(created, []);
  });
}

test("resolveFolderId reports a missing folder by label without creating it", async () => {
  const { resolveFolderId } = await load();
  stubFolders([CLIENT_A, Q1]);

  assert.deepEqual(await resolveFolderId("Plans", {}, 3), {
    error: 'Folder "Plans" not found. Available folders: Client A, Client A / Q1',
  });
});

test("resolveFolderId doesn't take a same-named subfolder of another parent for a label", async () => {
  const { resolveFolderId } = await load();
  const clientB = { id: 4, name: "Client B", space_id: 3, parent_folder_id: null };
  stubFolders([CLIENT_A, Q1, clientB]);
  window.electronAPI.createFolder = async () => ({
    success: false,
    error: "A folder with that name already exists",
  });

  assert.deepEqual(await resolveFolderId("Client B / Q1", { createIfMissing: true }, 3), {
    error:
      "A folder with that name already exists. Available folders: Client A, Client A / Q1, Client B",
  });
});

test("resolveFolderId guards against nullish, empty, and whitespace-only inputs", async () => {
  const { resolveFolderId } = await load();

  assert.deepEqual(await resolveFolderId(null), { error: "Folder name cannot be empty" });
  assert.deepEqual(await resolveFolderId(undefined), { error: "Folder name cannot be empty" });
  assert.deepEqual(await resolveFolderId(""), { error: "Folder name cannot be empty" });
  assert.deepEqual(await resolveFolderId("   "), { error: "Folder name cannot be empty" });
});

test("resolveSpace normalizes whitespace and guards nullish or empty inputs", async () => {
  const { resolveSpace } = await load();
  const spaces = [{ id: 1, name: "Engineering" }];

  assert.deepEqual(resolveSpace(spaces, "  engineering  "), { space: spaces[0] });
  assert.deepEqual(resolveSpace(spaces, null), { error: "Space name cannot be empty" });
  assert.deepEqual(resolveSpace(spaces, undefined), { error: "Space name cannot be empty" });
  assert.deepEqual(resolveSpace(spaces, "   "), { error: "Space name cannot be empty" });
});
