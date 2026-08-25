const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

// Successful note creation broadcasts to BrowserWindow via setImmediate, which
// reaches for electron after the test ends. Stub the broadcast so the 201 path
// can be exercised under plain node.
require.cache[require.resolve("../../src/helpers/windowBroadcast.js")] = {
  exports: { broadcastToWindows() {} },
};

const CliBridge = require("../../src/helpers/cliBridge.js");

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
  // Real http.IncomingMessage emits Buffer chunks (no setEncoding is called).
  const chunks = (Array.isArray(body) ? body : [body]).map((chunk) =>
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")
  );
  setImmediate(() => {
    for (const chunk of chunks) {
      request.emit("data", chunk);
    }
    request.emit("end");
  });
  return request;
}

function makeNoteBridge(onSave) {
  const bridge = new CliBridge({
    databaseManager: {
      saveNote(title, content) {
        onSave(title, content);
        return { success: true, note: { id: 1 } };
      },
    },
    _asyncVectorUpsert() {},
    _asyncMirrorWrite() {},
  });
  bridge.token = "test-token";
  bridge.port = 8200;
  return bridge;
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
  const bridge = makeNoteBridge(() => {
    saveCalls += 1;
  });

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

test("multibyte characters split across chunk boundaries decode correctly", async () => {
  let savedContent = null;
  const bridge = makeNoteBridge((_title, content) => {
    savedContent = content;
  });

  const content = "日本語のノート";
  const body = Buffer.from(JSON.stringify({ content }), "utf8");
  // Cut one byte into the 3-byte UTF-8 sequence for 日.
  const splitAt = body.indexOf(Buffer.from("日", "utf8")) + 1;
  assert.ok(splitAt > 0);

  const request = makeRequest([body.subarray(0, splitAt), body.subarray(splitAt)]);
  const response = makeResponse();
  await bridge._handleRequest(request, response);

  assert.equal(response.statusCode, 201);
  assert.equal(savedContent, content);
});

test("empty request body is treated as an empty object", async () => {
  let savedTitle = null;
  let savedContent = null;
  const bridge = makeNoteBridge((title, content) => {
    savedTitle = title;
    savedContent = content;
  });

  const request = makeRequest("");
  const response = makeResponse();
  await bridge._handleRequest(request, response);

  assert.equal(response.statusCode, 201);
  assert.equal(savedTitle, "Untitled Note");
  assert.equal(savedContent, "");
});

test("malformed JSON is rejected with a validation error", async () => {
  let saveCalls = 0;
  const bridge = makeNoteBridge(() => {
    saveCalls += 1;
  });

  const request = makeRequest('{"content": "unterminated');
  const response = makeResponse();
  await bridge._handleRequest(request, response);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.payload), {
    error: { code: "validation_error", message: "Invalid JSON payload" },
  });
  assert.equal(saveCalls, 0);
});

test("body exactly at the byte limit is accepted", async () => {
  let savedContent = null;
  const bridge = makeNoteBridge((_title, content) => {
    savedContent = content;
  });

  const overheadBytes = Buffer.byteLength(JSON.stringify({ content: "" }), "utf8");
  const content = "a".repeat(1 * 1024 * 1024 - overheadBytes);
  const body = JSON.stringify({ content });
  assert.equal(Buffer.byteLength(body, "utf8"), 1 * 1024 * 1024);

  const request = makeRequest(body);
  const response = makeResponse();
  await bridge._handleRequest(request, response);

  assert.equal(response.statusCode, 201);
  assert.equal(savedContent, content);
});
