const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function handlersFor(lifecycle) {
  const source = fs.readFileSync(require.resolve("../../src/helpers/ipcHandlers"), "utf8");
  const start = source.indexOf('    ipcMain.handle(\n      "db-semantic-search-notes"');
  const end = source.indexOf('    ipcMain.handle("db-update-note-cloud-id"', start);
  assert.ok(start !== -1 && end > start);
  const handlers = new Map();
  const context = {
    getSemanticSearch: () => lifecycle,
    databaseManager: {
      searchNotes: () => [{ id: 1, title: "Keyword" }],
      getNoteIdsInScope: () => [1, 2],
      getNote: (id) => ({ id, title: "Semantic" }),
    },
  };
  vm.runInNewContext(`(function() { ${source.slice(start, end)} }).call(context)`, {
    context,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    broadcastToWindows() {},
    debugLogger: { error() {} },
    require() {
      throw new Error("Search bypassed lifecycle owner");
    },
  });
  return handlers;
}

test("cold semantic search delegates warmup and returns keyword results", async () => {
  let requests = 0;
  const handlers = handlersFor({
    search: async () => {
      requests++;
      return null;
    },
  });
  const result = await handlers.get("db-semantic-search-notes")(null, "query", 5, 4);
  assert.equal(requests, 1);
  assert.equal(result[0].title, "Keyword");
});

test("warm search preserves fusion and excludes vectors outside SQLite scope", async () => {
  const handlers = handlersFor({
    search: async () => [
      { noteId: 9, score: 0.99 },
      { noteId: 2, score: 0.9 },
    ],
  });
  const results = await handlers.get("db-semantic-search-notes")(null, "query", 5, 4);
  assert.equal(results.length, 2);
  assert.ok(results.some((note) => note.id === 2));
  assert.ok(results.every((note) => note.id !== 9));
});

test("explicit reindex delegates lifecycle and preserves response", async () => {
  const expected = { success: true, indexed: 2 };
  const handlers = handlersFor({ reindex: async () => expected });
  assert.equal(await handlers.get("db-semantic-reindex-all")(), expected);
});

test("control panel mount cannot implicitly request a semantic reindex", () => {
  const source = fs.readFileSync(require.resolve("../../src/components/ControlPanel.tsx"), "utf8");
  assert.equal(source.includes("semanticReindexAll"), false);
});

test("application composition registers dormant semantic resources", () => {
  const source = fs.readFileSync(require.resolve("../../main.js"), "utf8");
  const start = source.indexOf('  const QdrantManager = require("./src/helpers/qdrantManager");');
  const end = source.indexOf('  if (process.platform === "win32")', start);
  const calls = [];
  const context = {
    databaseManager: {},
    debugLogger: {},
    sidecarRegistry: { register: (name, stop) => calls.push([name, stop]) },
    require(name) {
      if (name.endsWith("qdrantManager"))
        return class {
          start() {
            throw new Error("Eager Qdrant startup");
          }
        };
      if (name.endsWith("localEmbeddings"))
        return {
          LocalEmbeddings: { noteEmbedText() {} },
          downloadModel() {
            throw new Error("Eager model download");
          },
        };
      if (name.endsWith("vectorIndex")) return {};
      if (name.endsWith("semanticSearchLifecycle"))
        return require("../../src/helpers/semanticSearchLifecycle");
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  // The real owner binds the restart listener, but never starts the manager at construction.
  const originalRequire = context.require;
  context.require = (name) =>
    name.endsWith("qdrantManager")
      ? class extends require("node:events").EventEmitter {
          start() {
            throw new Error("Eager Qdrant startup");
          }
        }
      : originalRequire(name);
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.semanticSearch.ready, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "qdrant");
});
