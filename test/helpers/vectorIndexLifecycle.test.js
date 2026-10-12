const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadIndex() {
  const originalLoad = Module._load;
  let collectionError;
  let writeError;
  const calls = [];
  const client = {
    async getCollection() {
      if (collectionError) throw collectionError;
    },
    async createCollection() {
      calls.push("create");
    },
    async upsert(name, request) {
      calls.push(["upsert", request]);
      if (writeError) throw writeError;
    },
    async delete(name, request) {
      calls.push(["delete", request]);
      if (writeError) throw writeError;
    },
  };
  Module._load = function (request, parent, isMain) {
    if (request === "@qdrant/js-client-rest")
      return {
        QdrantClient: function () {
          return client;
        },
      };
    if (request === "./debugLogger") return { debug() {}, error() {} };
    if (request === "./localEmbeddings")
      return { embedText: async () => new Float32Array([1]), LocalEmbeddings: {} };
    if (request === "./conversationChunker") return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve("../../src/helpers/vectorIndex");
  delete require.cache[modulePath];
  try {
    return {
      index: require(modulePath),
      calls,
      failCollection(error) {
        collectionError = error;
      },
      failWrite(error) {
        writeError = error;
      },
    };
  } finally {
    Module._load = originalLoad;
  }
}

test("note writes acknowledge only completed successful Qdrant mutations", async () => {
  const h = loadIndex();
  h.index.init(6333);
  assert.equal(await h.index.upsertNote(1, "test"), true);
  assert.equal(await h.index.deleteNote(1), true);
  assert.equal(await h.index.deleteBySpace(5), true);
  for (const [, request] of h.calls) assert.equal(request.wait, true);
  h.failWrite(new Error("offline"));
  assert.equal(await h.index.upsertNote(1, "test"), false);
  assert.equal(await h.index.deleteNote(1), false);
});

test("collection startup distinguishes creation from availability failures", async () => {
  const h = loadIndex();
  h.index.init(6333);
  assert.deepEqual(await h.index.ensureCollection(), { created: false });
  h.failCollection({ status: 404 });
  assert.deepEqual(await h.index.ensureCollection(), { created: true });
  h.failCollection(new Error("offline"));
  await assert.rejects(h.index.ensureCollection(), /offline/);
  assert.equal(h.calls.filter((call) => call === "create").length, 1);
});

test("reset invalidates readiness and prevents acknowledging writes", async () => {
  const h = loadIndex();
  h.index.init(6333);
  h.index.reset();
  assert.equal(await h.index.upsertNote(1, "test"), false);
  assert.equal(await h.index.deleteNote(1), false);
});
