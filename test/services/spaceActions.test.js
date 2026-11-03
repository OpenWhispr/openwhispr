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
      setMemberRole: async (spaceId, userId, role) =>
        calls.push(["space.setMemberRole", spaceId, userId, role]),
      removeMember: async (spaceId, userId) => {
        calls.push(["space.removeMember", spaceId, userId]);
        return { removed: true, still_via_teams: [] };
      },
      join: async (spaceId) => {
        calls.push(["space.join", spaceId]);
        return { joined: true };
      },
      addMembers: async (spaceId, userIds) => {
        calls.push(["space.addMembers", spaceId, userIds]);
        return { added: userIds, already_members: [] };
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
      getSpaces: async () => {
        calls.push(["local.getSpaces"]);
        return [localSpace];
      },
    },
    mirror: {
      upsertCloudSpaces: async (spaces) =>
        calls.push(["mirror.upsert", spaces.map((space) => space.id)]),
    },
    sync: {
      requestSyncAll: (reason) => calls.push(["sync", reason]),
    },
    markSpacePurged: async (spaceId, reason) => calls.push(["guard", spaceId, reason]),
    releasePurgedSpace: async (spaceId) => calls.push(["releasePurgedSpace", spaceId]),
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

test("renameSpace sends a description to the server and keeps it out of the local mirror", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const actions = createSpaceActions(deps);

  const result = await actions.renameSpace(localSpace, {
    name: "Roadmap",
    emoji: null,
    description: "Plans for the year",
  });

  assert.deepEqual(result, { success: true });
  assert.deepEqual(
    calls.filter(([name]) => name === "local.update"),
    [["local.update", 7, { name: "Roadmap", emoji: null }]],
    "the mirror holds no description column"
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "space.update"),
    [
      [
        "space.update",
        "cloud-space-1",
        { name: "Roadmap", emoji: null, description: "Plans for the year" },
      ],
    ]
  );
});

test("renameSpace can clear a description", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const actions = createSpaceActions(deps);

  await actions.renameSpace(localSpace, { name: "Roadmap", emoji: null, description: null });

  assert.deepEqual(
    calls.find(([name]) => name === "space.update"),
    ["space.update", "cloud-space-1", { name: "Roadmap", emoji: null, description: null }]
  );
});

test("renameSpace without a description leaves it out of the request", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const actions = createSpaceActions(deps);

  await actions.renameSpace(localSpace, { name: "Roadmap", emoji: "🧭" });

  assert.deepEqual(
    calls.find(([name]) => name === "space.update"),
    ["space.update", "cloud-space-1", { name: "Roadmap", emoji: "🧭" }]
  );
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

test("renameSpace keeps the mirror's access fields, which the rename response omits", async () => {
  const { createSpaceActions } = await load();
  const { deps } = makeHarness();
  const capabilities = {
    edit_notes: true,
    manage_members: true,
    manage_settings: true,
    leave: true,
  };
  const teams = [{ id: "team-1", name: "Design", my_role: "admin" }];
  const space = {
    id: 7,
    cloud_space_id: "cloud-space-1",
    name: "Roadmap",
    emoji: null,
    my_role: "admin",
    my_direct_role: null,
    member_count: 4,
    teams,
    capabilities,
  };
  // PATCH /api/spaces/:id answers with the space row only.
  deps.spaces.update = async (spaceId, updates) => ({
    id: spaceId,
    workspace_id: "ws-1",
    slug: "roadmap",
    description: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-23T00:00:00.000Z",
    ...updates,
  });
  let upserted = null;
  deps.local.upsertSpaceFromCloud = async (row) => {
    upserted = row;
    return space;
  };
  const actions = createSpaceActions(deps);

  assert.deepEqual(await actions.renameSpace(space, { name: "Plans", emoji: null }), {
    success: true,
  });
  assert.equal(upserted.id, "cloud-space-1");
  assert.equal(upserted.name, "Plans");
  assert.equal(upserted.my_role, "admin");
  assert.equal(upserted.my_direct_role, null);
  assert.equal(upserted.member_count, 4);
  assert.deepEqual(upserted.teams, teams);
  assert.deepEqual(upserted.capabilities, capabilities);
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
    failure: { kind: "failed" },
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
  await assert.rejects(actions.leaveSpace(localOnly, "me"), /Not a cloud space/);
  assert.equal(calls.length, 0);
});

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

// What GET /api/me/spaces lists for a teamspace the caller just created.
const ownCreate = (overrides = {}) => ({
  id: "cloud-space-9",
  workspace_id: "workspace-1",
  name: "Roadmap",
  my_role: "admin",
  my_direct_role: "admin",
  created_at: minutesAgo(1),
  ...overrides,
});

test("createSpace sends the description and both flags when given", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  const actions = createSpaceActions(deps);

  await actions.createSpace(
    "workspace-1",
    { name: "Roadmap", description: "Plans", is_default: true, is_open: false },
    { memberIds: [], teamIds: [] }
  );

  assert.deepEqual(calls[0], [
    "space.create",
    "workspace-1",
    {
      name: "Roadmap",
      description: "Plans",
      is_default: true,
      is_open: false,
      member_ids: [],
      team_ids: [],
    },
  ]);
});

test("joining refreshes the mirror and asks for a sync", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  const actions = createSpaceActions(deps);

  assert.deepEqual(await actions.joinSpace("cloud-space-1"), { joined: true });

  assert.deepEqual(calls, [
    ["space.join", "cloud-space-1"],
    ["releasePurgedSpace", "cloud-space-1"],
    ["roster.invalidate", undefined],
    ["space.mySpaces"],
    ["mirror.upsert", ["cloud-space-1"]],
    ["local.load"],
    ["sync", "manual"],
  ]);
});

test("joining releases the purge guard before refreshing", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  const actions = createSpaceActions(deps);

  await actions.joinSpace("cloud-space-1");

  // Leaving a space guards its id for 15 minutes, and the refresh skips guarded ids, so the
  // rejoined space would never reach the mirror.
  assert.deepEqual(
    calls
      .map(([name]) => name)
      .filter((name) => ["space.join", "releasePurgedSpace", "space.mySpaces"].includes(name)),
    ["space.join", "releasePurgedSpace", "space.mySpaces"]
  );
});

test("joining reports a space the caller was already in", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  deps.spaces.join = async () => ({ joined: false });
  const actions = createSpaceActions(deps);

  assert.deepEqual(await actions.joinSpace("cloud-space-1"), { joined: false });
  assert.ok(
    calls.some(([name]) => name === "releasePurgedSpace"),
    "already being in the space is as good as joining it"
  );
});

test("a refused join leaves the guard alone", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeHarness();
  const refusal = new CloudApiError("Space is not open", 403, "space_not_open");
  deps.spaces.join = async () => {
    throw refusal;
  };
  const actions = createSpaceActions(deps);

  await assert.rejects(actions.joinSpace("cloud-space-1"), refusal);
  assert.equal(calls.length, 0);
});

test("adding people refreshes the mirror once and returns the server's lists", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  deps.spaces.addMembers = async (spaceId, userIds) => {
    calls.push(["space.addMembers", spaceId, userIds]);
    return { added: ["user-1"], already_members: ["user-2"] };
  };
  const actions = createSpaceActions(deps);

  const result = await actions.addPeopleToSpace("cloud-space-1", ["user-1", "user-2"]);

  assert.deepEqual(result, { added: ["user-1"], already_members: ["user-2"] });
  assert.deepEqual(calls, [
    ["space.addMembers", "cloud-space-1", ["user-1", "user-2"]],
    ["roster.invalidate", undefined],
    ["space.mySpaces"],
    ["mirror.upsert", ["cloud-space-1"]],
    ["local.load"],
    ["sync", "manual"],
  ]);
});

test("a retried delete that finds it archived reports success", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps, localSpace } = makeHarness();
  // The first delete went through but its answer was lost, so the retry meets an archived space.
  deps.spaces.remove = async (spaceId) => {
    calls.push(["space.remove", spaceId]);
    throw new CloudApiError("Space archived", 410, "space_archived");
  };
  const actions = createSpaceActions(deps);

  assert.deepEqual(await actions.deleteSpace(localSpace), { success: true });
  assert.deepEqual(calls, [
    ["space.remove", "cloud-space-1"],
    ["roster.invalidate", "cloud-space-1"],
    ["guard", "cloud-space-1", "deleted"],
    ["local.purge", 7],
  ]);
});

test("a delete that finds the teamspace gone reports success and drops the mirror's copy", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps, localSpace } = makeHarness();
  // Someone else deleted it first, so there is nothing left to retry against.
  deps.spaces.remove = async (spaceId) => {
    calls.push(["space.remove", spaceId]);
    throw new CloudApiError("Space not found", 404, "space_not_found");
  };
  const actions = createSpaceActions(deps);

  assert.deepEqual(await actions.deleteSpace(localSpace), { success: true });
  assert.deepEqual(calls, [
    ["space.remove", "cloud-space-1"],
    ["roster.invalidate", "cloud-space-1"],
    ["guard", "cloud-space-1", "deleted"],
    ["local.purge", 7],
  ]);
});

test("a bare 404 with no space code is not proof the teamspace is gone, so nothing is purged", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps, localSpace } = makeHarness();
  // A proxy or a wrong route answers like this; only the server's own space_not_found means gone.
  deps.spaces.remove = async () => {
    throw new CloudApiError("API error: 404", 404);
  };
  const actions = createSpaceActions(deps);

  const result = await actions.deleteSpace(localSpace);

  assert.equal(result.success, false);
  assert.deepEqual(
    calls.filter(([name]) => name === "local.purge" || name === "guard"),
    [],
    "the local copy and its notes are kept"
  );
  assert.deepEqual(calls, [], "the roster and the mirror are left alone too");
});

test("a failed delete carries its kind", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps, localSpace } = makeHarness();
  deps.spaces.remove = async () => {
    throw new CloudApiError("Insufficient role", 403);
  };
  const actions = createSpaceActions(deps);

  assert.deepEqual(await actions.deleteSpace(localSpace), {
    success: false,
    error: "Insufficient role",
    failure: { kind: "notAllowed" },
  });
  assert.deepEqual(calls, [], "a refused delete leaves the roster, the guard and the mirror alone");
});

test("a retried create that finds its own teamspace reports success", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps, localSpace } = makeHarness();
  const found = ownCreate();
  deps.spaces.create = async () => {
    throw new CloudApiError("Cloud API request failed", 0);
  };
  deps.spaces.mySpaces = async () => {
    calls.push(["space.mySpaces"]);
    return [ownCreate({ id: "cloud-space-8", name: "Other" }), found];
  };
  deps.local.upsertSpaceFromCloud = async (space) => {
    calls.push(["local.upsert", space.id]);
    return localSpace;
  };
  const actions = createSpaceActions(deps);

  const space = await actions.createSpace(
    "workspace-1",
    { name: "  Roadmap " },
    { memberIds: [], teamIds: [] }
  );

  assert.equal(space, localSpace);
  assert.deepEqual(calls, [
    ["space.mySpaces"],
    ["local.upsert", "cloud-space-9"],
    ["local.setStatus", 7, "synced"],
    ["local.load"],
    ["sync", "manual"],
  ]);
});

test("a lost create with no matching teamspace rethrows", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeHarness();
  const lost = new CloudApiError("Cloud API request failed", 0);
  deps.spaces.create = async () => {
    throw lost;
  };
  // Each of these fails one of the four tests a teamspace of the caller's own has to pass.
  deps.spaces.mySpaces = async () => [
    ownCreate({ name: "Roadmaps" }),
    ownCreate({ workspace_id: "workspace-2" }),
    ownCreate({ my_direct_role: "member" }),
    ownCreate({ my_direct_role: null, my_role: "admin" }),
  ];
  const actions = createSpaceActions(deps);

  await assert.rejects(
    actions.createSpace("workspace-1", { name: "Roadmap" }, { memberIds: [], teamIds: [] }),
    (error) => error === lost
  );
  assert.equal(calls.filter(([name]) => name.startsWith("local.")).length, 0);
});

test("a refusal with a code at status 0 never looks", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeHarness();
  // Main refuses the request itself when the session changed; it never reached the server.
  const refusal = new CloudApiError("Session changed", 0, "AUTH_CONTEXT_CHANGED");
  deps.spaces.create = async () => {
    throw refusal;
  };
  deps.spaces.mySpaces = async () => {
    calls.push(["space.mySpaces"]);
    return [ownCreate()];
  };
  const actions = createSpaceActions(deps);

  await assert.rejects(
    actions.createSpace("workspace-1", { name: "Roadmap" }, { memberIds: [], teamIds: [] }),
    (error) => error === refusal
  );
  assert.equal(calls.length, 0);
});

test("a lost create whose lookup fails too rethrows the create's error", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeHarness();
  const lost = new CloudApiError("Cloud API request failed", 0);
  deps.spaces.create = async () => {
    throw lost;
  };
  deps.spaces.mySpaces = async () => {
    throw new CloudApiError("Cloud API request failed", 0);
  };
  const actions = createSpaceActions(deps);

  await assert.rejects(
    actions.createSpace("workspace-1", { name: "Roadmap" }, { memberIds: [], teamIds: [] }),
    (error) => error === lost
  );
});

test("an old same-name teamspace doesn't count", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeHarness();
  const lost = new CloudApiError("Cloud API request failed", 0);
  deps.spaces.create = async () => {
    throw lost;
  };
  deps.spaces.mySpaces = async () => [ownCreate({ created_at: minutesAgo(6) })];
  const actions = createSpaceActions(deps);

  await assert.rejects(
    actions.createSpace("workspace-1", { name: "Roadmap" }, { memberIds: [], teamIds: [] }),
    (error) => error === lost
  );
});

test("a name-taken refusal never looks", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");

  // The server answered, so there is nothing lost to find; a same-name space of the caller's
  // would be the very one that made the name taken.
  for (const refusal of [
    new CloudApiError("Name taken", 409, "space_name_taken"),
    new CloudApiError("Name taken", 409),
    new CloudApiError("Server error", 500),
  ]) {
    const { calls, deps } = makeHarness();
    deps.spaces.create = async () => {
      throw refusal;
    };
    deps.spaces.mySpaces = async () => {
      calls.push(["space.mySpaces"]);
      return [ownCreate()];
    };
    const actions = createSpaceActions(deps);

    await assert.rejects(
      actions.createSpace("workspace-1", { name: "Roadmap" }, { memberIds: [], teamIds: [] }),
      (error) => error === refusal
    );
    assert.equal(calls.length, 0);
  }
});

test("flags go through update and refresh the mirror", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  const actions = createSpaceActions(deps);

  await actions.setSpaceAccessFlags("cloud-space-1", { is_open: true });

  assert.deepEqual(calls, [
    ["space.update", "cloud-space-1", { is_open: true }],
    ["roster.invalidate", undefined],
    ["space.mySpaces"],
    ["mirror.upsert", ["cloud-space-1"]],
    ["local.load"],
  ]);
});

test("a failed mirror refresh after the flags saved isn't a failed save", async (t) => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  t.mock.method(console, "error", () => {});
  deps.spaces.mySpaces = async () => {
    calls.push(["space.mySpaces"]);
    throw new Error("offline");
  };
  const actions = createSpaceActions(deps);

  // The server has the change, so the caller is told so, and the sync pass catches the mirror up.
  await actions.setSpaceAccessFlags("cloud-space-1", { is_open: true });

  assert.deepEqual(calls.at(-1), ["sync", "manual"]);
});

test("a flags save the server refuses is still a failed save, and leaves the mirror alone", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  deps.spaces.update = async () => {
    throw new Error("Insufficient role");
  };
  const actions = createSpaceActions(deps);

  await assert.rejects(
    actions.setSpaceAccessFlags("cloud-space-1", { is_open: true }),
    /Insufficient role/
  );
  assert.deepEqual(calls, []);
});

test("leaving a space that no longer has the caller counts as left, and refreshes the mirror", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps, localSpace } = makeHarness();
  // An earlier leave went through and its answer was lost, or the space was deleted meanwhile.
  deps.spaces.removeMember = async (spaceId, userId) => {
    calls.push(["space.removeMember", spaceId, userId]);
    throw new CloudApiError("Member not found", 404);
  };
  const actions = createSpaceActions(deps);

  assert.deepEqual(await actions.leaveSpace(localSpace, "me"), {
    removed: false,
    still_via_teams: [],
  });
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      "space.removeMember",
      "roster.invalidate",
      "space.mySpaces",
      "mirror.upsert",
      "local.load",
      "sync",
    ]
  );
  assert.deepEqual(calls.at(-1), ["sync", "manual"]);
});

test("a leave that fails any other way still throws, without touching the mirror", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps, localSpace } = makeHarness();
  deps.spaces.removeMember = async () => {
    throw new CloudApiError("You are the only admin", 409, "last_space_admin");
  };
  deps.teams.removeMember = async () => {
    throw new CloudApiError("API error: 500", 500);
  };
  const actions = createSpaceActions(deps);

  await assert.rejects(actions.leaveSpace(localSpace, "me"), { code: "last_space_admin" });
  await assert.rejects(actions.leaveTeam("team-1", "me"), { status: 500 });
  assert.deepEqual(calls, []);
});

test("leaving a group the caller is already out of counts as left, and refreshes the mirror", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeHarness();
  deps.teams.removeMember = async (teamId, userId) => {
    calls.push(["team.removeMember", teamId, userId]);
    throw new CloudApiError("Member not found", 404);
  };
  const actions = createSpaceActions(deps);

  await actions.leaveTeam("team-1", "me");

  assert.deepEqual(
    calls.map(([name]) => name),
    [
      "team.removeMember",
      "roster.invalidate",
      "space.mySpaces",
      "mirror.upsert",
      "local.load",
      "sync",
    ]
  );
});

test("localSpaceIdFor refreshes once on a miss", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  let mirrored = false;
  deps.mirror.upsertCloudSpaces = async () => {
    mirrored = true;
  };
  deps.local.getSpaces = async () => {
    calls.push(["local.getSpaces"]);
    return mirrored ? [localSpace] : [];
  };
  const actions = createSpaceActions(deps);

  assert.equal(await actions.localSpaceIdFor("cloud-space-1"), 7);
  assert.deepEqual(
    calls.filter(([name]) => name === "space.mySpaces" || name === "local.getSpaces"),
    [["local.getSpaces"], ["space.mySpaces"], ["local.getSpaces"]]
  );
});

test("localSpaceIdFor reads the mirror alone when the space is there", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  const actions = createSpaceActions(deps);

  assert.equal(await actions.localSpaceIdFor("cloud-space-1"), 7);
  assert.deepEqual(calls, [["local.getSpaces"]]);
});

test("localSpaceIdFor gives null when a refreshed mirror still lacks the space", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  deps.local.getSpaces = async () => {
    calls.push(["local.getSpaces"]);
    return [];
  };
  const actions = createSpaceActions(deps);

  assert.equal(await actions.localSpaceIdFor("cloud-space-1"), null);
  assert.equal(calls.filter(([name]) => name === "space.mySpaces").length, 1);
});
