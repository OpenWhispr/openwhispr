const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

// Captures what the service hands the main process, pinning the wire contract.
function installCloudCapture(t, responseData = {}) {
  const requests = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async (options) => {
          requests.push(options);
          return { success: true, data: responseData };
        },
      },
    },
  });
  return requests;
}

function loadService() {
  return require("../../src/services/SharedDictionaryService.ts").SharedDictionaryService;
}

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

test("list sends the workspace and paging cursor as query parameters", async (t) => {
  const requests = installCloudCapture(t, { entries: [], hasMore: false });

  await loadService().list(WORKSPACE, {
    since: "2026-10-20T10:00:00.000Z",
    sinceId: "e-1",
    limit: 200,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(
    requests[0].path,
    `/api/shared-dictionary/list?workspace_id=${WORKSPACE}&since=2026-10-20T10%3A00%3A00.000Z&since_id=e-1&limit=200`
  );
});

test("list and hides use cursor/cursor_id for snapshot paging and omit unset params", async (t) => {
  const requests = installCloudCapture(t, {});

  await loadService().list(WORKSPACE, { cursor: "c", cursorId: "ci" });
  await loadService().hides(WORKSPACE, { cursor: "c", cursorId: "ci", limit: 500 });
  await loadService().hides(WORKSPACE, {});

  const url = (index) => new URL(requests[index].path, "https://x.test");
  assert.equal(url(0).pathname, "/api/shared-dictionary/list");
  assert.equal(url(0).searchParams.get("cursor"), "c");
  assert.equal(url(0).searchParams.get("cursor_id"), "ci");
  assert.equal(url(0).searchParams.has("since"), false);
  assert.equal(url(1).pathname, "/api/shared-dictionary/hides");
  assert.equal(url(1).searchParams.get("limit"), "500");
  assert.equal(requests[2].path, `/api/shared-dictionary/hides?workspace_id=${WORKSPACE}`);
});

test("create sends space_id explicitly, null for the workspace list", async (t) => {
  const requests = installCloudCapture(t, { created: [], alreadyPresent: [] });

  await loadService().create(WORKSPACE, null, ["Kubernetes"]);

  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/shared-dictionary/create");
  assert.deepEqual(requests[0].body, {
    workspace_id: WORKSPACE,
    space_id: null,
    words: ["Kubernetes"],
  });
});

test("create with 201 words throws a RangeError and sends nothing", async (t) => {
  const requests = installCloudCapture(t);
  const words = Array.from({ length: 201 }, (_, index) => `word${index}`);

  await assert.rejects(() => loadService().create(WORKSPACE, null, words), RangeError);
  assert.equal(requests.length, 0);
});

test("create accepts exactly 200 words", async (t) => {
  const requests = installCloudCapture(t, { created: [], alreadyPresent: [] });
  const words = Array.from({ length: 200 }, (_, index) => `word${index}`);

  await loadService().create(WORKSPACE, null, words);

  assert.equal(requests.length, 1);
});

test("update patches the entry with the workspace and new word", async (t) => {
  const requests = installCloudCapture(t, { id: "e-1" });

  await loadService().update(WORKSPACE, "e-1", "OpenWhispr");

  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].path, "/api/shared-dictionary/update");
  assert.deepEqual(requests[0].body, { workspace_id: WORKSPACE, id: "e-1", word: "OpenWhispr" });
});

test("remove sends a DELETE with a JSON body", async (t) => {
  const requests = installCloudCapture(t, { deletedIds: ["e-1"] });

  const result = await loadService().remove(WORKSPACE, ["e-1"]);

  assert.deepEqual(result, { deletedIds: ["e-1"] });
  assert.equal(requests[0].method, "DELETE");
  assert.equal(requests[0].path, "/api/shared-dictionary/delete");
  assert.deepEqual(requests[0].body, { workspace_id: WORKSPACE, ids: ["e-1"] });
});

test("restore and hide post ids to their routes", async (t) => {
  const requests = installCloudCapture(t, {});

  await loadService().restore(WORKSPACE, ["e-1", "e-2"]);
  await loadService().hide(WORKSPACE, ["e-1"], true);

  assert.equal(requests[0].path, "/api/shared-dictionary/restore");
  assert.deepEqual(requests[0].body, { workspace_id: WORKSPACE, ids: ["e-1", "e-2"] });
  assert.equal(requests[1].path, "/api/shared-dictionary/hide");
  assert.deepEqual(requests[1].body, { workspace_id: WORKSPACE, ids: ["e-1"], hidden: true });
});

test("share posts targets, personal words and plain words", async (t) => {
  const requests = installCloudCapture(t, {
    created: [],
    alreadyPresent: [],
    movedPersonalIds: [],
  });

  await loadService().share(WORKSPACE, {
    targets: [null, "space-1"],
    personal: [{ id: "p-1", word: "Whisper" }],
    words: ["Qdrant"],
  });

  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/shared-dictionary/share");
  assert.deepEqual(requests[0].body, {
    workspace_id: WORKSPACE,
    targets: [null, "space-1"],
    personal: [{ id: "p-1", word: "Whisper" }],
    words: ["Qdrant"],
  });
});

test("share, remove, restore and hide refuse more than 200 items before any request", async (t) => {
  const requests = installCloudCapture(t);
  const service = loadService();
  const ids = Array.from({ length: 201 }, (_, index) => `id-${index}`);
  const personal = ids.slice(0, 150).map((id) => ({ id, word: id }));
  const words = ids.slice(0, 51);

  await assert.rejects(
    () => service.share(WORKSPACE, { targets: [null], personal, words }),
    RangeError
  );
  await assert.rejects(() => service.remove(WORKSPACE, ids), RangeError);
  await assert.rejects(() => service.restore(WORKSPACE, ids), RangeError);
  await assert.rejects(() => service.hide(WORKSPACE, ids, false), RangeError);
  assert.equal(requests.length, 0);
});

test("API failures surface as CloudApiError with status and code", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async () => ({
          success: false,
          error: "cursor expired",
          status: 410,
          code: "SHARED_DICTIONARY_CURSOR_EXPIRED",
        }),
      },
    },
  });

  await assert.rejects(
    () => loadService().list(WORKSPACE, { since: "2026-01-01T00:00:00.000Z" }),
    (error) => error.status === 410 && error.code === "SHARED_DICTIONARY_CURSOR_EXPIRED"
  );
});

test("share refuses more than 20 targets before any request", async (t) => {
  const requests = installCloudCapture(t, { created: [], alreadyPresent: [] });
  const targets = Array.from({ length: 21 }, (_, index) => `space-${index}`);

  await assert.rejects(
    () => loadService().share(WORKSPACE, { targets, personal: [], words: ["Qdrant"] }),
    RangeError
  );
  assert.equal(requests.length, 0);

  await loadService().share(WORKSPACE, { targets: targets.slice(1), personal: [], words: ["Q"] });
  assert.equal(requests.length, 1);
});
