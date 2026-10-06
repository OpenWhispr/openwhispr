const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/spaceActionsCore.ts");

function makeHarness() {
  const calls = [];
  const cloudSpace = { id: "cloud-space-1", name: "Roadmap" };
  const localSpace = {
    id: 7,
    cloud_space_id: "cloud-space-1",
    name: "Roadmap",
    emoji: null,
  };
  const deps = {
    teams: {
      remove: async (teamId) => calls.push(["team.remove", teamId]),
      addMember: async (teamId, userId, role) =>
        calls.push(["team.addMember", teamId, userId, role]),
      removeMember: async (teamId, userId) => calls.push(["team.removeMember", teamId, userId]),
    },
    spaces: {
      mySpaces: async () => {
        calls.push(["space.mySpaces"]);
        return [cloudSpace];
      },
      create: async (workspaceId, input) => {
        calls.push(["space.create", workspaceId, input]);
        return cloudSpace;
      },
      update: async (spaceId, updates) => {
        calls.push(["space.update", spaceId, updates]);
        return { ...cloudSpace, ...updates };
      },
      remove: async (spaceId) => calls.push(["space.remove", spaceId]),
      assignTeam: async (spaceId, teamId, access) =>
        calls.push(["space.assignTeam", spaceId, teamId, access]),
      unassignTeam: async (spaceId, teamId) => calls.push(["space.unassignTeam", spaceId, teamId]),
      addMember: async (spaceId, userId, role) =>
        calls.push(["space.addMember", spaceId, userId, role]),
      setMemberRole: async (spaceId, userId, role) =>
        calls.push(["space.setMemberRole", spaceId, userId, role]),
      removeMember: async (spaceId, userId) => {
        calls.push(["space.removeMember", spaceId, userId]);
        return { removed: true, still_via_teams: [] };
      },
    },
    local: {
      upsertSpaceFromCloud: async (space) => {
        calls.push(["local.upsert", space.id]);
        return localSpace;
      },
      setSpaceSyncStatus: async (id, status) => calls.push(["local.setStatus", id, status]),
      updateSpaceMeta: async (id, updates) => {
        calls.push(["local.update", id, updates]);
        return { success: true };
      },
      purgeSpace: async (id) => {
        calls.push(["local.purge", id]);
        return { success: true };
      },
      loadSpaces: async () => calls.push(["local.load"]),
    },
    mirror: {
      upsertCloudSpaces: async (spaces) =>
        calls.push(["mirror.upsert", spaces.map((space) => space.id)]),
    },
    sync: {
      requestSyncAll: (reason) => calls.push(["sync", reason]),
    },
    markSpacePurged: async (spaceId, reason) => calls.push(["guard", spaceId, reason]),
    invalidateSpaceRoster: (spaceId) => calls.push(["roster.invalidate", spaceId]),
  };
  return { calls, cloudSpace, localSpace, deps };
}

test("createSpace sends members and teams in one body, settles locally, and syncs", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const actions = createSpaceActions(deps);

  const space = await actions.createSpace(
    "workspace-1",
    { name: "Roadmap", emoji: "🧭" },
    { memberIds: ["user-1", "user-2"], teamIds: ["existing-team"] }
  );

  assert.equal(space, localSpace);
  assert.deepEqual(calls[0], [
    "space.create",
    "workspace-1",
    {
      name: "Roadmap",
      emoji: "🧭",
      member_ids: ["user-1", "user-2"],
      team_ids: ["existing-team"],
    },
  ]);
  assert.ok(calls.some((call) => call[0] === "local.upsert"));
  assert.ok(calls.some((call) => call[0] === "local.setStatus" && call[2] === "synced"));
  assert.deepEqual(calls.at(-1), ["sync", "manual"]);
});

test("createSpace leaves no local trace when the cloud create fails", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  const failure = new Error("plan limit");
  deps.spaces.create = async () => {
    throw failure;
  };
  const actions = createSpaceActions(deps);

  await assert.rejects(
    actions.createSpace("workspace-1", { name: "Roadmap" }, { memberIds: [], teamIds: [] }),
    failure
  );
  assert.equal(calls.length, 0);
});

test("renameSpace rolls back a rejected cloud rename", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  deps.spaces.update = async () => {
    throw new Error("offline");
  };
  const actions = createSpaceActions(deps);

  const result = await actions.renameSpace(localSpace, { name: "New name", emoji: "✨" });

  assert.deepEqual(result, { success: false, error: "offline" });
  assert.deepEqual(
    calls.filter(([name]) => name === "local.update"),
    [
      ["local.update", 7, { name: "New name", emoji: "✨" }],
      ["local.update", 7, { name: "Roadmap", emoji: null }],
    ]
  );
  assert.ok(calls.some((call) => call[0] === "local.setStatus" && call[2] === "synced"));
});

test("renameSpace leaves a server-successful rename pending when mirroring fails", async (t) => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  t.mock.method(console, "error", () => {});
  deps.local.upsertSpaceFromCloud = async () => {
    throw new Error("database unavailable");
  };
  const actions = createSpaceActions(deps);

  assert.deepEqual(await actions.renameSpace(localSpace, { name: "New name", emoji: null }), {
    success: true,
  });
  assert.deepEqual(calls.at(-1), ["sync", "manual"]);
  assert.equal(
    calls.filter(([name]) => name === "local.update").length,
    1,
    "a server-successful rename must not roll back locally"
  );
});

test("deleteSpace archives and guards cloud rows before local purge", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const actions = createSpaceActions(deps);

  assert.deepEqual(await actions.deleteSpace(localSpace), { success: true });
  assert.deepEqual(calls, [
    ["space.remove", "cloud-space-1"],
    ["roster.invalidate", "cloud-space-1"],
    ["guard", "cloud-space-1", "deleted"],
    ["local.purge", 7],
  ]);

  calls.length = 0;
  deps.spaces.remove = async () => {
    throw new Error("forbidden");
  };
  assert.deepEqual(await actions.deleteSpace(localSpace), {
    success: false,
    error: "forbidden",
  });
  assert.equal(
    calls.some(([name]) => name === "local.purge"),
    false
  );
});

test("team mutations refresh the full mirror and schedule sync only when needed", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const actions = createSpaceActions(deps);

  await actions.assignTeamToSpace(localSpace, "team-1");
  await actions.setSpaceTeamAccess(localSpace, "team-1", "admin");
  await actions.unassignTeamFromSpace(localSpace, "team-1");
  await actions.removeTeamMember("team-1", "user-1");
  await actions.setTeamMemberRole("team-1", "user-1", "admin");
  await actions.leaveTeam("team-1", "user-1");
  await actions.deleteTeam("team-1");

  assert.equal(
    calls.filter(([name]) => name === "roster.invalidate").length,
    7,
    "every membership or assignment change invalidates before refreshing"
  );
  assert.equal(calls.filter(([name]) => name === "mirror.upsert").length, 7);
  assert.equal(calls.filter(([name]) => name === "local.load").length, 7);
  assert.equal(
    calls.filter(([name]) => name === "sync").length,
    3,
    "unassign, leave, and delete can revoke container access"
  );
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "space.assignTeam" &&
        call[1] === "cloud-space-1" &&
        call[2] === "team-1" &&
        call[3] === "admin"
    )
  );
});

test("direct member mutations refresh the mirror and only leaving schedules sync", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const stillViaTeams = [{ team_id: "team-1", name: "Sales" }];
  deps.spaces.removeMember = async (spaceId, userId) => {
    calls.push(["space.removeMember", spaceId, userId]);
    return { removed: true, still_via_teams: stillViaTeams };
  };
  const actions = createSpaceActions(deps);

  await actions.setSpaceMemberRole(localSpace, "user-1", "admin");
  const removed = await actions.removeSpaceMember(localSpace, "user-1");
  const left = await actions.leaveSpace(localSpace, "me");

  assert.deepEqual(removed.still_via_teams, stillViaTeams);
  assert.deepEqual(left.still_via_teams, stillViaTeams);
  assert.deepEqual(
    calls.filter(([name]) => name.startsWith("space.")),
    [
      ["space.setMemberRole", "cloud-space-1", "user-1", "admin"],
      ["space.mySpaces"],
      ["space.removeMember", "cloud-space-1", "user-1"],
      ["space.mySpaces"],
      ["space.removeMember", "cloud-space-1", "me"],
      ["space.mySpaces"],
    ]
  );
  assert.equal(calls.filter(([name]) => name === "roster.invalidate").length, 3);
  assert.equal(calls.filter(([name]) => name === "mirror.upsert").length, 3);
  assert.deepEqual(
    calls.filter(([name]) => name === "sync"),
    [["sync", "manual"]],
    "only leaving can revoke the caller's own container access"
  );
});

test("addSpaceMembers reports partial failures and still refreshes the mirror", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  deps.spaces.addMember = async (spaceId, userId) => {
    calls.push(["space.addMember", spaceId, userId]);
    if (userId === "bad-user") throw new Error("not in workspace");
  };
  const actions = createSpaceActions(deps);

  const { failures } = await actions.addSpaceMembers(localSpace, ["good-user", "bad-user"]);

  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /not in workspace/);
  assert.deepEqual(
    calls.filter(([name]) => name === "space.addMember"),
    [
      ["space.addMember", "cloud-space-1", "good-user"],
      ["space.addMember", "cloud-space-1", "bad-user"],
    ]
  );
  assert.ok(calls.some(([name]) => name === "mirror.upsert"));
});

test("addTeamMembers reports partial failures and still refreshes the mirror", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  deps.teams.addMember = async (_teamId, userId) => {
    if (userId === "bad-user") throw new Error("bad member");
  };
  const actions = createSpaceActions(deps);

  const { failures } = await actions.addTeamMembers("team-1", ["good-user", "bad-user"]);

  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /bad member/);
  assert.ok(calls.some(([name]) => name === "mirror.upsert"));
});

test("team assignment rejects local-only spaces before making a cloud request", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const actions = createSpaceActions(deps);

  const localOnly = { ...localSpace, cloud_space_id: null };
  await assert.rejects(actions.assignTeamToSpace(localOnly, "team-1"), /Not a cloud space/);
  await assert.rejects(actions.addSpaceMembers(localOnly, ["user-1"]), /Not a cloud space/);
  await assert.rejects(actions.leaveSpace(localOnly, "me"), /Not a cloud space/);
  assert.equal(calls.length, 0);
});
