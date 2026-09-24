const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const originalLoad = Module._load;
const broadcasts = [];

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => "/tmp",
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  if (request === "./windowBroadcast") {
    return {
      broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const CliBridge = require("../../src/helpers/cliBridge.js");

Module._load = originalLoad;

function createBridge(dbMocks = {}) {
  const bridge = new CliBridge({
    databaseManager: {
      getNote: () => null,
      updateNote: () => ({ success: false, error: "Note not found" }),
      ...dbMocks,
    },
    notifyVectorChanges() {},
    _asyncMirrorWrite() {},
  });
  bridge.token = "test-token";
  bridge.port = 8200;
  return bridge;
}

function makeRequest(method, url, body = null) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.headers = { authorization: "Bearer test-token" };
  request.socket = { remoteAddress: "127.0.0.1" };
  request.destroyed = false;
  request.destroy = () => {
    request.destroyed = true;
  };
  setImmediate(() => {
    if (body !== null) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      request.emit("data", Buffer.from(payload));
    }
    request.emit("end");
  });
  return request;
}

function makeResponse() {
  return {
    headersSent: false,
    statusCode: null,
    headers: {},
    payload: "",
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body = "") {
      this.payload = body;
    },
  };
}

test("PATCH /v1/notes/:id responds with HTTP 404 not_found when note does not exist", async () => {
  const bridge = createBridge({
    updateNote(_id, _updates) {
      return { success: false, error: "Note not found" };
    },
  });

  const req = makeRequest("PATCH", "/v1/notes/999", { title: "New Title" });
  const res = makeResponse();

  await bridge._handleRequest(req, res);

  assert.equal(res.statusCode, 404);
  const parsed = JSON.parse(res.payload);
  assert.equal(parsed.error.code, "not_found");
  assert.equal(parsed.error.message, "Note not found");
});

test("PATCH /v1/notes/:id responds with HTTP 404 not_found when target folder does not exist", async () => {
  const bridge = createBridge({
    updateNote(_id, _updates) {
      return { success: false, error: "Folder not found" };
    },
  });

  const req = makeRequest("PATCH", "/v1/notes/1", { folder_id: 888 });
  const res = makeResponse();

  await bridge._handleRequest(req, res);

  assert.equal(res.statusCode, 404);
  const parsed = JSON.parse(res.payload);
  assert.equal(parsed.error.code, "not_found");
  assert.equal(parsed.error.message, "Folder not found");
});

test("PATCH /v1/notes/:id responds with HTTP 404 not_found for invalid non-integer id", async () => {
  const bridge = createBridge();

  const req = makeRequest("PATCH", "/v1/notes/invalid-id", { title: "New Title" });
  const res = makeResponse();

  await bridge._handleRequest(req, res);

  assert.equal(res.statusCode, 404);
  const parsed = JSON.parse(res.payload);
  assert.equal(parsed.error.code, "not_found");
  assert.equal(parsed.error.message, "Invalid note id");
});

test("PATCH /v1/notes/:id responds with HTTP 200 and updated note on success", async () => {
  let passedId = null;
  let passedUpdates = null;
  const bridge = createBridge({
    updateNote(id, updates) {
      passedId = id;
      passedUpdates = updates;
      return { success: true, note: { id, title: updates.title, content: "Existing content" } };
    },
  });

  const req = makeRequest("PATCH", "/v1/notes/42", { title: "Updated Title" });
  const res = makeResponse();

  await bridge._handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(passedId, 42);
  assert.deepEqual(passedUpdates, { title: "Updated Title" });
  const parsed = JSON.parse(res.payload);
  assert.deepEqual(parsed.data, { id: 42, title: "Updated Title", content: "Existing content" });
});
