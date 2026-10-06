const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
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
      broadcastToWindows: () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const CliBridge = require("../../src/helpers/cliBridge.js");

Module._load = originalLoad;

function createBridge(dbMocks = {}) {
  const bridge = new CliBridge({
    databaseManager: {
      getNotes: () => [],
      searchNotes: () => [],
      getTranscriptions: () => [],
      ...dbMocks,
    },
  });
  bridge.token = "test-token";
  bridge.port = 8200;
  return bridge;
}

class MockResponse {
  constructor() {
    this.statusCode = null;
    this.headers = {};
    this.body = "";
  }
  writeHead(code, headers) {
    this.statusCode = code;
    this.headers = headers;
  }
  end(chunk) {
    if (chunk) this.body += chunk;
  }
}

async function request(bridge, url) {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { authorization: "Bearer test-token" },
    method: "GET",
    url,
  };
  const res = new MockResponse();
  await bridge._handleRequest(req, res);
  const parsed = res.body ? JSON.parse(res.body) : null;
  return { status: res.statusCode, data: parsed };
}

test("GET /v1/notes/list accepts valid limit and folder_id parameters", async () => {
  let passedLimit = null;
  let passedFolderId = null;
  const bridge = createBridge({
    getNotes(_type, limit, folderId) {
      passedLimit = limit;
      passedFolderId = folderId;
      return [{ id: 1, title: "Note 1" }];
    },
  });

  const res = await request(bridge, "/v1/notes/list?limit=25&folder_id=7");
  assert.equal(res.status, 200);
  assert.equal(passedLimit, 25);
  assert.equal(passedFolderId, 7);
  assert.deepEqual(res.data.data, [{ id: 1, title: "Note 1" }]);
});

test("GET /v1/notes/list uses defaults when parameters are omitted", async () => {
  let passedLimit = null;
  let passedFolderId = null;
  const bridge = createBridge({
    getNotes(_type, limit, folderId) {
      passedLimit = limit;
      passedFolderId = folderId;
      return [];
    },
  });

  const res = await request(bridge, "/v1/notes/list");
  assert.equal(res.status, 200);
  assert.equal(passedLimit, 100);
  assert.equal(passedFolderId, null);
});

test("GET /v1/notes/list rejects non-numeric or non-positive limit with 400", async () => {
  const bridge = createBridge();

  for (const badLimit of ["abc", "-5", "0", "1.5"]) {
    const res = await request(bridge, `/v1/notes/list?limit=${badLimit}`);
    assert.equal(res.status, 400, `limit=${badLimit} should return 400`);
    assert.equal(res.data.error.code, "validation_error");
    assert.match(res.data.error.message, /must be a positive integer/);
  }
});

test("GET /v1/notes/list rejects non-numeric or non-positive folder_id with 400", async () => {
  const bridge = createBridge();

  for (const badFolder of ["abc", "-1", "0", "2.5"]) {
    const res = await request(bridge, `/v1/notes/list?folder_id=${badFolder}`);
    assert.equal(res.status, 400, `folder_id=${badFolder} should return 400`);
    assert.equal(res.data.error.code, "validation_error");
    assert.match(res.data.error.message, /must be a positive integer/);
  }
});

test("GET /v1/notes/search rejects invalid limit with 400", async () => {
  const bridge = createBridge();

  const res = await request(bridge, "/v1/notes/search?q=test&limit=invalid");
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "validation_error");
  assert.match(res.data.error.message, /must be a positive integer/);
});

test("GET /v1/transcriptions/list rejects invalid limit with 400", async () => {
  const bridge = createBridge();

  const res = await request(bridge, "/v1/transcriptions/list?limit=zero");
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "validation_error");
  assert.match(res.data.error.message, /must be a positive integer/);
});
