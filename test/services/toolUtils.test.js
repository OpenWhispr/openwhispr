const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

let loaded;
const load = () => {
  if (!loaded) {
    const filename = path.join(__dirname, "../../src/services/tools/utils.ts");
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    loaded = import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  }
  return loaded;
};

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
