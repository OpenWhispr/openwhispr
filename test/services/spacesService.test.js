const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

// Captures the IPC payload the services hand to the main process, so the wire
// bodies the API's zod schemas receive are pinned here.
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

test("SpacesService.create sends member_ids alongside team_ids", async (t) => {
  const requests = installCloudCapture(t, { id: "space-1", my_direct_role: "admin" });
  const { SpacesService } = require("../../src/services/SpacesService.ts");

  const space = await SpacesService.create("ws-1", {
    name: "Roadmap",
    emoji: null,
    member_ids: ["user-1"],
    team_ids: [],
  });

  assert.equal(space.my_direct_role, "admin");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/spaces");
  assert.deepEqual(requests[0].body, {
    name: "Roadmap",
    emoji: null,
    member_ids: ["user-1"],
    team_ids: [],
  });
});

test("SpacesService direct-member calls hit the members routes with the API's field names", async (t) => {
  const stillViaTeams = [{ team_id: "team-1", name: "Sales" }];
  const requests = installCloudCapture(t, { removed: true, still_via_teams: stillViaTeams });
  const { SpacesService } = require("../../src/services/SpacesService.ts");

  await SpacesService.addMember("space-1", "user-1");
  await SpacesService.addMember("space-1", "user-2", "admin");
  await SpacesService.setMemberRole("space-1", "user-1", "admin");
  const removal = await SpacesService.removeMember("space-1", "user-1");

  assert.deepEqual(
    requests.map(({ method, path, body }) => [method, path, body]),
    [
      ["POST", "/api/spaces/space-1/members", { user_id: "user-1", role: "member" }],
      ["POST", "/api/spaces/space-1/members", { user_id: "user-2", role: "admin" }],
      ["PATCH", "/api/spaces/space-1/members/user-1", { role: "admin" }],
      ["DELETE", "/api/spaces/space-1/members/user-1", undefined],
    ]
  );
  assert.deepEqual(removal, { removed: true, still_via_teams: stillViaTeams });
});

test("InvitationsService.send forwards space_ids and accept surfaces the granted space ids", async (t) => {
  const requests = installCloudCapture(t, {
    workspace_id: "ws-1",
    role: "member",
    team_ids: [],
    space_ids: ["space-1"],
  });
  const { InvitationsService } = require("../../src/services/InvitationsService.ts");

  await InvitationsService.send("ws-1", { email: "new@example.com", space_ids: ["space-1"] });
  const accepted = await InvitationsService.accept("tok en");

  assert.equal(requests[0].path, "/api/workspaces/ws-1/invitations");
  assert.deepEqual(requests[0].body, { email: "new@example.com", space_ids: ["space-1"] });
  assert.equal(requests[1].path, "/api/invitations/tok%20en/accept");
  assert.deepEqual(accepted.space_ids, ["space-1"]);
});
