const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const originalLoad = Module._load;
// Routes broadcast through the shared windowBroadcast module, which reaches for
// Electron's BrowserWindow; capture the calls so they can be asserted here.
const broadcasts = [];

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./windowBroadcast") {
    return {
      broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const CliBridge = require("../../src/helpers/cliBridge.js");

Module._load = originalLoad;

function flushImmediates() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeRequest(body) {
  const request = new EventEmitter();
  request.method = "POST";
  request.url = "/v1/notes/create";
  request.headers = { authorization: "Bearer test-token" };
  request.socket = { remoteAddress: "127.0.0.1" };
  request.destroyed = false;
  request.destroy = () => {
    request.destroyed = true;
  };
  const chunks = Array.isArray(body) ? body : [body];
  setImmediate(() => {
    for (const chunk of chunks) request.emit("data", chunk);
    request.emit("end");
  });
  return request;
}

function makeResponse() {
  return {
    headersSent: false,
    statusCode: null,
    payload: "",
    writeHead(statusCode) {
      this.statusCode = statusCode;
      this.headersSent = true;
    },
    end(body = "") {
      this.payload = body;
    },
  };
}

test("CLI request body limit counts UTF-8 bytes, not JavaScript characters", async () => {
  let saveCalls = 0;
  const bridge = new CliBridge({
    databaseManager: {
      saveNote() {
        saveCalls += 1;
        return { success: true, note: { id: 1 } };
      },
    },
    _asyncVectorUpsert() {},
    _asyncMirrorWrite() {},
  });
  bridge.token = "test-token";
  bridge.port = 8200;

  const body = JSON.stringify({ content: "😀".repeat(300_000) });
  assert.ok(body.length < 1 * 1024 * 1024);
  assert.ok(Buffer.byteLength(body, "utf8") > 1 * 1024 * 1024);

  const request = makeRequest(body);
  const response = makeResponse();
  await bridge._handleRequest(request, response);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.payload), {
    error: { code: "validation_error", message: "Request body too large" },
  });
  assert.equal(request.destroyed, true);
  assert.equal(saveCalls, 0);
});

test("multibyte content split across request chunks is preserved", async () => {
  let savedContent = null;
  const bridge = new CliBridge({
    databaseManager: {
      saveNote(_title, content) {
        savedContent = content;
        return { success: true, note: { id: 1 } };
      },
    },
    _asyncVectorUpsert() {},
    _asyncMirrorWrite() {},
  });
  bridge.token = "test-token";
  bridge.port = 8200;

  const content = "日本語のノート";
  const body = Buffer.from(JSON.stringify({ content }));
  const splitAt = Buffer.byteLength('{"content":"') + 1;
  const request = makeRequest([body.subarray(0, splitAt), body.subarray(splitAt)]);
  const response = makeResponse();
  await bridge._handleRequest(request, response);
  await flushImmediates();

  assert.equal(response.statusCode, 201);
  assert.equal(savedContent, content);
  assert.equal(broadcasts.at(-1)?.channel, "note-added");
});

test("a JSON body exactly at the byte limit is accepted", async () => {
  let saveCalls = 0;
  const bridge = new CliBridge({
    databaseManager: {
      saveNote() {
        saveCalls += 1;
        return { success: true, note: { id: 1 } };
      },
    },
    _asyncVectorUpsert() {},
    _asyncMirrorWrite() {},
  });
  bridge.token = "test-token";
  bridge.port = 8200;

  const wrapperBytes = Buffer.byteLength('{"content":""}');
  const body = JSON.stringify({ content: "a".repeat(1 * 1024 * 1024 - wrapperBytes) });
  assert.equal(Buffer.byteLength(body, "utf8"), 1 * 1024 * 1024);

  const request = makeRequest(body);
  const response = makeResponse();
  await bridge._handleRequest(request, response);
  await flushImmediates();

  assert.equal(response.statusCode, 201);
  assert.equal(saveCalls, 1);
});
