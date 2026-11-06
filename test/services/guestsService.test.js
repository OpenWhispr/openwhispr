const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

function installCloudCapture(t, responseData = {}) {
  const requests = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async (options) => {
          requests.push(options);
          return { success: true, data: { data: responseData } };
        },
      },
    },
  });
  return requests;
}

test("list unwraps data and hits the workspace path", async (t) => {
  const requests = installCloudCapture(t, [{ email: "a@x.com", notes: [] }]);
  const { GuestsService } = require("../../src/services/GuestsService.ts");

  const guests = await GuestsService.list("ws-1");

  assert.deepEqual(guests, [{ email: "a@x.com", notes: [] }]);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/guests");
});

test("remove posts emails and note_id, and omits note_id when absent", async (t) => {
  const removal = {
    removed: ["a@x.com"],
    not_found: [],
    skipped_members: [],
    link_shared_note_ids: [],
  };
  const requests = installCloudCapture(t, removal);
  const { GuestsService } = require("../../src/services/GuestsService.ts");

  const withNote = await GuestsService.remove("ws-1", { emails: ["a@x.com"], note_id: "n1" });
  await GuestsService.remove("ws-1", { emails: ["a@x.com", "b@x.com"] });

  assert.deepEqual(withNote, removal);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/guests/remove");
  assert.deepEqual(requests[0].body, { emails: ["a@x.com"], note_id: "n1" });
  assert.deepEqual(requests[1].body, { emails: ["a@x.com", "b@x.com"] });
  assert.equal("note_id" in requests[1].body, false);
});
