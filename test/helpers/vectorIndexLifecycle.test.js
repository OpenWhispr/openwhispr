const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadIndex() {
  const originalLoad = Module._load;
  let collectionError;
  let writeError;
  let searchResults = [];
  const calls = [];
  const client = {
    async search(_name, request) {
      calls.push(["search", request]);
      const allowed = request.filter?.must?.[0]?.match?.any;
      return searchResults
        .filter((hit) => !allowed || allowed.includes(hit.payload.conversation_id))
        .slice(0, request.limit);
    },
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
      setSearchResults: (results) => {
        searchResults = results;
      },
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

test("conversation vectors apply allowed IDs before ranking and preserve unscoped searches", async () => {
  const h = loadIndex();
  h.index.init(6333);
  h.setSearchResults([
    ...Array.from({ length: 200 }, (_, index) => ({
      score: 0.99,
      payload: { conversation_id: index + 2 },
    })),
    { score: 0.8, payload: { conversation_id: 1 } },
  ]);
  assert.deepEqual(await h.index.searchConversations("query", 1, [1]), [
    { conversationId: 1, score: 0.8 },
  ]);
  assert.deepEqual(await h.index.searchConversations("query", 1), [
    { conversationId: 2, score: 0.99 },
  ]);
  assert.deepEqual(await h.index.searchConversations("query", 1, []), []);
});
