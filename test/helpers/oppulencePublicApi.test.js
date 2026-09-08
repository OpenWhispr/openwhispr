const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

process.env.ELECTRON_OVERRIDE_DIST_PATH ||= "/tmp";

const { OppulencePublicAPI } = require("../../extensions/oppulence-cloud/publicApi.ts");

function fixture() {
  const scopes = [];
  const note = {
    id: 42,
    title: "API contract",
    content: "Local note",
    note_type: "personal",
    created_at: "2026-08-21T12:00:00Z",
    updated_at: "2026-08-21T12:00:00Z",
  };
  const databaseManager = {
    getNotes: () => [note],
    searchNotes: () => [note],
    getNote: () => note,
    saveNote: () => ({ success: true, note }),
    updateNote: () => ({ success: true, note }),
    getFolders: () => [],
    createFolder: () => ({ success: true, folder: { id: 1, name: "Folder" } }),
    getTranscriptions: () => [],
    getTranscriptionById: () => null,
  };
  const api = new OppulencePublicAPI({
    app: {},
    apiURL: "https://api.oppulence.io",
    ipcHandlers: {
      databaseManager,
      _asyncVectorUpsert() {},
      _asyncMirrorWrite() {},
      deleteNoteInternal: () => ({ success: true }),
      deleteTranscriptionInternal: () => ({ success: true }),
    },
    logger: {},
    tokenStore: { get: () => null },
    verifier: {
      authorize: async (secret, scope) => {
        scopes.push(scope);
        return secret === "opv_live_test";
      },
    },
  });
  return { api, scopes };
}

async function request(api, pathname, options = {}) {
  const server = http.createServer((req, res) => {
    void api.handle(req, res, new URL(req.url, "http://127.0.0.1"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fetch(`http://127.0.0.1:${port}${pathname}`, {
      headers: { authorization: "Bearer opv_live_test", ...options.headers },
      method: options.method,
      body: options.body,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("published note list is Zod-validated and maps local IDs to stable UUIDs", async () => {
  const { api, scopes } = fixture();
  const response = await request(api, "/api/v1/notes/list?limit=10");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].id, "00000000-0000-4000-8000-00000000002a");
  assert.deepEqual(scopes, ["notes:read"]);
});

test("published API rejects query values outside its Zod contract", async () => {
  const { api } = fixture();
  const response = await request(api, "/api/v1/notes/list?limit=not-a-number");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "validation_error");
});

test("personal API keys fail closed for workspace spaces", async () => {
  const { api } = fixture();
  const response = await request(api, "/api/v1/spaces/list");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "workspace_key_required");
});

test("the CLI bridge builds the Oppulence API lazily, so it works outside Electron", async () => {
  // The public API caches verifier state under app.getPath("userData"). When
  // the bridge built it in its constructor, merely constructing a CliBridge
  // under the Oppulence distribution threw outside a running Electron
  // process — which broke the release build's own test run.
  process.env.DISTRIBUTION_MANIFEST = "distributions/oppulence-voice.json";
  const CliBridge = require("../../src/helpers/cliBridge.js");

  const bridge = new CliBridge({ saveNote: () => ({ success: true }) });

  assert.equal(bridge.oppulencePublicAPI, null, "no Electron app means no public API");
});
