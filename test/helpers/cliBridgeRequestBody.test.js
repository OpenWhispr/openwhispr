const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => process.cwd(),
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const CliBridge = require("../../src/helpers/cliBridge.js");

Module._load = originalLoad;

async function postJson(chunks) {
  const bridge = new CliBridge({ databaseManager: {} });
  bridge.port = 8200;
  bridge.token = "test-token";
  bridge.routes = [
    {
      method: "POST",
      match: (pathname) => (pathname === "/test" ? {} : null),
      handler: ({ body }) => ({ data: body }),
    },
  ];

  const req = new EventEmitter();
  req.method = "POST";
  req.url = "/test";
  req.headers = { authorization: "Bearer test-token" };
  req.socket = { remoteAddress: "127.0.0.1" };
  req.destroy = () => {
    req.destroyed = true;
  };

  const res = {
    headersSent: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body = "") {
      this.body = body;
    },
  };

  const handled = bridge._handleRequest(req, res);
  for (const chunk of chunks) req.emit("data", chunk);
  req.emit("end");
  await handled;

  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.body),
    requestDestroyed: Boolean(req.destroyed),
  };
}

test("POST preserves a multibyte JSON value split across request chunks", async () => {
  const json = Buffer.from(JSON.stringify({ value: "😀" }));
  const emojiStart = Buffer.byteLength('{"value":"');
  const response = await postJson([
    json.subarray(0, emojiStart + 2),
    json.subarray(emojiStart + 2),
  ]);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.value, "😀");
});

test("POST rejects a multibyte body that exceeds the byte limit", async () => {
  const json = Buffer.from(JSON.stringify({ value: "😀".repeat(300_000) }));

  assert.ok(json.length > MAX_REQUEST_BODY_BYTES);
  assert.ok(json.toString("utf8").length < MAX_REQUEST_BODY_BYTES);

  const response = await postJson([json]);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    error: { code: "validation_error", message: "Request body too large" },
  });
  assert.equal(response.requestDestroyed, true);
});

test("POST accepts a JSON body exactly at the byte limit", async () => {
  const wrapperBytes = Buffer.byteLength('{"value":""}');
  const json = Buffer.from(
    JSON.stringify({ value: "a".repeat(MAX_REQUEST_BODY_BYTES - wrapperBytes) })
  );

  assert.equal(json.length, MAX_REQUEST_BODY_BYTES);

  const response = await postJson([json]);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.value.length, MAX_REQUEST_BODY_BYTES - wrapperBytes);
});
