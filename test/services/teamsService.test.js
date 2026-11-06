const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

// Captures the IPC payload the service hands to the main process, so the wire shapes the API
// receives are pinned here.
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

test("list reads the workspace's teams", async (t) => {
  const requests = installCloudCapture(t, [{ id: "team-1" }]);
  const { TeamsService } = require("../../src/services/TeamsService.ts");

  const teams = await TeamsService.list("ws-1");

  assert.deepEqual(teams, [{ id: "team-1" }]);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/teams");
});

test("create sends the founding members in the body", async (t) => {
  const requests = installCloudCapture(t, { id: "team-1" });
  const { TeamsService } = require("../../src/services/TeamsService.ts");

  await TeamsService.create("ws-1", { name: "Sales", member_ids: ["u1", "u2"] });

  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/teams");
  assert.deepEqual(requests[0].body, { name: "Sales", member_ids: ["u1", "u2"] });
});

test("setMemberRole patches the member, so it can't add someone who left", async (t) => {
  const requests = installCloudCapture(t);
  const { TeamsService } = require("../../src/services/TeamsService.ts");

  await TeamsService.setMemberRole("team-1", "user-1", "admin");

  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].path, "/api/teams/team-1/members/user-1");
  assert.deepEqual(requests[0].body, { role: "admin" });
});

test("update patches the team", async (t) => {
  const requests = installCloudCapture(t, { id: "team-1", name: "Revenue" });
  const { TeamsService } = require("../../src/services/TeamsService.ts");

  const team = await TeamsService.update("team-1", { name: "Revenue" });

  assert.equal(team.name, "Revenue");
  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].path, "/api/teams/team-1");
  assert.deepEqual(requests[0].body, { name: "Revenue" });
});

test("addMembers posts one batch and returns the server's lists", async (t) => {
  const requests = installCloudCapture(t, { added: ["u1"], already_members: ["u2"] });
  const { TeamsService } = require("../../src/services/TeamsService.ts");

  const result = await TeamsService.addMembers("team-1", ["u1", "u2"]);

  assert.deepEqual(result, { added: ["u1"], already_members: ["u2"] });
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/teams/team-1/members/batch");
  assert.deepEqual(requests[0].body, { user_ids: ["u1", "u2"] });
});

test("listInvitations reads the team's pending invitations", async (t) => {
  const requests = installCloudCapture(t, [{ id: "inv-1", email: "a@b.co" }]);
  const { TeamsService } = require("../../src/services/TeamsService.ts");

  const invitations = await TeamsService.listInvitations("team-1");

  assert.equal(invitations[0].email, "a@b.co");
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].path, "/api/teams/team-1/invitations");
});
