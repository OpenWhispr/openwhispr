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

test("InvitationsService.sendBatch forwards space_ids and accept surfaces the granted space ids", async (t) => {
  const requests = installCloudCapture(t, {
    workspace_id: "ws-1",
    role: "member",
    team_ids: [],
    space_ids: ["space-1"],
  });
  const { InvitationsService } = require("../../src/services/InvitationsService.ts");

  await InvitationsService.sendBatch("ws-1", {
    emails: ["new@example.com"],
    role: "member",
    space_ids: ["space-1"],
  });
  const accepted = await InvitationsService.accept("tok en");

  assert.equal(requests[0].path, "/api/workspaces/ws-1/invitations/batch");
  assert.deepEqual(requests[0].body, {
    emails: ["new@example.com"],
    role: "member",
    space_ids: ["space-1"],
  });
  assert.equal(requests[1].path, "/api/invitations/tok%20en/accept");
  assert.deepEqual(accepted.space_ids, ["space-1"]);
});

test("WorkspacesService previews and runs a removal with the API's field names", async (t) => {
  const requests = installCloudCapture(t, {
    members: [],
    already_removed: [],
    transfer_required: false,
  });
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");

  await WorkspacesService.previewMemberRemoval("ws-1", ["user-2", "user-3"]);
  await WorkspacesService.removeMembers("ws-1", { userIds: ["user-2"], transferTo: "user-1" });
  await WorkspacesService.removeMembers("ws-1", { userIds: ["user-3"] });

  assert.deepEqual(
    requests.map(({ method, path, body }) => [method, path, body]),
    [
      [
        "POST",
        "/api/workspaces/ws-1/members/remove",
        { user_ids: ["user-2", "user-3"], preview: true },
      ],
      [
        "POST",
        "/api/workspaces/ws-1/members/remove",
        { user_ids: ["user-2"], transfer_to: "user-1" },
      ],
      ["POST", "/api/workspaces/ws-1/members/remove", { user_ids: ["user-3"] }],
    ]
  );
});

test("SpacesService.create forwards is_default, is_open and description only when given", async (t) => {
  const requests = installCloudCapture(t, { id: "space-1" });
  const { SpacesService } = require("../../src/services/SpacesService.ts");

  await SpacesService.create("ws-1", { name: "Plain", member_ids: [], team_ids: [] });
  await SpacesService.create("ws-1", {
    name: "Everyone",
    description: "All hands",
    is_default: true,
    is_open: true,
    member_ids: [],
    team_ids: [],
  });

  assert.deepEqual(requests[0].body, { name: "Plain", member_ids: [], team_ids: [] });
  assert.deepEqual(requests[1].body, {
    name: "Everyone",
    description: "All hands",
    is_default: true,
    is_open: true,
    member_ids: [],
    team_ids: [],
  });
});

test("SpacesService.update sends the patch as given, including a cleared description", async (t) => {
  const requests = installCloudCapture(t, { id: "space-1" });
  const { SpacesService } = require("../../src/services/SpacesService.ts");

  await SpacesService.update("space-1", { is_default: false, is_open: true, description: null });

  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].path, "/api/spaces/space-1");
  assert.deepEqual(requests[0].body, { is_default: false, is_open: true, description: null });
});

test("SpacesService.listInWorkspace reads the workspace's spaces and unwraps data", async (t) => {
  const rows = [{ id: "space-1", is_default: true, can_join: false }];
  const requests = installCloudCapture(t, rows);
  const { SpacesService } = require("../../src/services/SpacesService.ts");

  const spaces = await SpacesService.listInWorkspace("ws-1");

  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/spaces");
  assert.deepEqual(spaces, rows);
});

test("SpacesService.coverage posts user_ids and unwraps the per-space counts", async (t) => {
  const counts = [{ space_id: "space-1", count: 2 }];
  const requests = installCloudCapture(t, counts);
  const { SpacesService } = require("../../src/services/SpacesService.ts");

  const coverage = await SpacesService.coverage("ws-1", ["user-1", "user-2"]);

  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/spaces/coverage");
  assert.deepEqual(requests[0].body, { user_ids: ["user-1", "user-2"] });
  assert.deepEqual(coverage, counts);
});

test("SpacesService.join posts to the join route and unwraps the outcome", async (t) => {
  const requests = installCloudCapture(t, { joined: true });
  const { SpacesService } = require("../../src/services/SpacesService.ts");

  const outcome = await SpacesService.join("space-1");

  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/spaces/space-1/join");
  assert.deepEqual(outcome, { joined: true });
});

test("SpacesService.addMembers posts user_ids to the batch route and unwraps the outcome", async (t) => {
  const outcome = { added: ["user-1"], already_members: ["user-2"] };
  const requests = installCloudCapture(t, outcome);
  const { SpacesService } = require("../../src/services/SpacesService.ts");

  const result = await SpacesService.addMembers("space-1", ["user-1", "user-2"]);

  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/spaces/space-1/members/batch");
  assert.deepEqual(requests[0].body, { user_ids: ["user-1", "user-2"] });
  assert.deepEqual(result, outcome);
});

test("SpacesService.listInvitations reads the space's invitations and unwraps data", async (t) => {
  const invitations = [
    {
      id: "inv-1",
      email: "new@example.com",
      role: "member",
      expires_at: "2026-11-10T00:00:00Z",
      created_at: "2026-11-03T00:00:00Z",
    },
  ];
  const requests = installCloudCapture(t, invitations);
  const { SpacesService } = require("../../src/services/SpacesService.ts");

  const result = await SpacesService.listInvitations("space-1");

  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].path, "/api/spaces/space-1/invitations");
  assert.deepEqual(result, invitations);
});
