const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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
  setImmediate(() => {
    request.emit("data", body);
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
