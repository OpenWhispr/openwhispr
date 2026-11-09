const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

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
      setMemberRole: async (teamId, userId, role) =>
        calls.push(["team.setMemberRole", teamId, userId, role]),
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
    deleteHold: {
      accountGeneration: () => 1,
      hide: (space, cloudSpaceId) => {
        calls.push(["hold.hide", space.id, cloudSpaceId]);
        return async (reopen) => calls.push(["hold.bringBack", reopen]);
      },
      release: (space, cloudSpaceId) => calls.push(["hold.release", space.id, cloudSpaceId]),
      markDeleted: (space) => calls.push(["hold.markDeleted", space.id]),
    },
    markSpacePurged: async (spaceId, reason) => calls.push(["guard", spaceId, reason]),
    releasePurgedSpace: async (spaceId) => calls.push(["releasePurgedSpace", spaceId]),
    invalidateSpaceRoster: (spaceId) => calls.push(["roster.invalidate", spaceId]),
    refreshWorkspaceRoster: async (workspaceId) => calls.push(["people.refresh", workspaceId]),
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

test("renameSpace says when the name is taken", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps, localSpace } = makeHarness();
  deps.spaces.update = async () => {
    throw new CloudApiError("Name taken", 409, "space_name_taken");
  };

  const result = await createSpaceActions(deps).renameSpace(localSpace, {
    name: "Taken",
    emoji: null,
  });

  assert.deepEqual(result.failure, { kind: "nameTaken" });
});

test("renameSpace rolls back a rejected cloud rename", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  deps.spaces.update = async () => {
    throw new Error("offline");
  };
  const actions = createSpaceActions(deps);

  const result = await actions.renameSpace(localSpace, { name: "New name", emoji: "✨" });

  assert.deepEqual(result, { success: false, error: "offline", failure: { kind: "failed" } });
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

  assert.equal(
    calls.filter(([name]) => name === "roster.invalidate").length,
    6,
    "every membership or assignment change invalidates before refreshing"
  );
  assert.equal(calls.filter(([name]) => name === "mirror.upsert").length, 6);
  assert.equal(calls.filter(([name]) => name === "local.load").length, 6);
  assert.equal(
    calls.filter(([name]) => name === "sync").length,
    2,
    "unassign and leave can revoke container access"
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

test("a new assignment sends no access, so an existing one keeps its own", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  const actions = createSpaceActions(deps);

  await actions.assignTeamToSpaces("team-1", ["space-a", "space-b"]);

  assert.deepEqual(
    calls.filter(([name]) => name === "space.assignTeam"),
    [
      ["space.assignTeam", "space-a", "team-1", undefined],
      ["space.assignTeam", "space-b", "team-1", undefined],
    ]
  );
});

test("assignTeamToSpaces tries every teamspace in order, reports the failures and refreshes once", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  const boom = new Error("offline");
  deps.spaces.assignTeam = async (spaceId, teamId) => {
    calls.push(["space.assignTeam", spaceId, teamId]);
    if (spaceId === "space-a") throw boom;
  };
  const actions = createSpaceActions(deps);

  const { failures } = await actions.assignTeamToSpaces("team-1", ["space-a", "space-b"]);

  assert.deepEqual(
    calls.filter(([name]) => name === "space.assignTeam").map(([, spaceId]) => spaceId),
    ["space-a", "space-b"]
  );
  assert.deepEqual(failures, [{ spaceId: "space-a", error: boom }]);
  assert.equal(calls.filter(([name]) => name === "mirror.upsert").length, 1);
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

const namesOf = (calls) => calls.map((call) => call[0]);

test("a held delete only hides the teamspace: nothing is sent, guarded or purged", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();

  createSpaceActions(deps).holdSpaceDelete(localSpace);

  assert.deepEqual(calls, [["hold.hide", 7, "cloud-space-1"]]);
});

test("leaving the page sends what's still held, but not what was undone or already sent", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const actions = createSpaceActions(deps);
  const undone = actions.holdSpaceDelete(localSpace);
  await undone.undo();
  calls.length = 0;

  const held = actions.holdSpaceDelete(localSpace);
  actions.commitHeldDeletes();
  await new Promise((resolve) => setImmediate(resolve));
  actions.commitHeldDeletes();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(namesOf(calls).filter((name) => name === "space.remove").length, 1);
  assert.equal(await held.commit(), null, "the toast ending later has nothing left to do");
});

test("quit can wait for what's still held: the promise ends once the delete has gone", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  let answer;
  deps.spaces.remove = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const actions = createSpaceActions(deps);
  actions.holdSpaceDelete(localSpace);

  let finished = false;
  const committing = Promise.resolve(actions.commitHeldDeletes()).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);

  answer();
  await committing;
  assert.ok(namesOf(calls).includes("local.purge"));
});

test("the app's own actions send what's held at quit and at unload, and never refuse the unload", async (t) => {
  const listeners = {};
  installBrowserGlobals(t, {
    window: { addEventListener: (name, listener) => (listeners[name] = listener) },
  });
  const removed = [];
  globalThis.__spaceRemoved = (id) => removed.push(id);
  t.after(() => delete globalThis.__spaceRemoved);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-space-actions-",
    mockModules: {
      // The API client reads the language from here, and the real one starts i18next.
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/TeamsService": "export const TeamsService = {};",
      "/SpacesService": `
        export const SpacesService = { remove: async (id) => globalThis.__spaceRemoved(id) };
      `,
      "/SyncService": `
        export const syncService = {};
        export const upsertCloudSpaces = async () => [];
        export const markSpacePurged = async () => {};
        export const releasePurgedSpace = async () => {};
      `,
      "/stores/noteStore": `
        export const getAccountGeneration = () => 0;
        export const hideSpaceInView = () => async () => {};
        export const loadSpaces = async () => [];
        export const updateSpaceMeta = async () => ({ success: true });
        export const purgeSpace = async () => ({ success: true });
      `,
    },
  });
  const { holdSpaceDelete } = await vite.ssrLoadModule("/services/spaceActions.ts");

  holdSpaceDelete({ id: 7, cloud_space_id: "cloud-7", name: "Roadmap" });
  await globalThis.window.commitHeldSpaceDeletes();
  assert.deepEqual(removed, ["cloud-7"]);

  holdSpaceDelete({ id: 8, cloud_space_id: "cloud-8", name: "Plans" });
  // Electron takes a returned value as refusing the unload.
  assert.equal(listeners.beforeunload(), undefined);
  assert.deepEqual(removed, ["cloud-7", "cloud-8"]);
});

test("Undo releases the hold and returns to the view, and the delete never goes", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const hold = createSpaceActions(deps).holdSpaceDelete(localSpace);

  assert.equal(await hold.undo(), true);
  assert.equal(await hold.commit(), null);
  assert.equal(await hold.undo(), false, "a second press has nothing to do");

  assert.deepEqual(
    calls.slice(1).filter(([name]) => name !== "local.getSpaces"),
    [
      ["hold.release", 7, "cloud-space-1"],
      ["hold.bringBack", true],
    ]
  );
});

test("commit sends the delete once, purges, and Undo no longer applies", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const hold = createSpaceActions(deps).holdSpaceDelete(localSpace);

  assert.deepEqual(await hold.commit(), { success: true });
  assert.equal(await hold.undo(), false);
  assert.equal(await hold.commit(), null);

  const order = namesOf(calls);
  assert.equal(order.filter((name) => name === "space.remove").length, 1);
  assert.ok(order.indexOf("space.remove") < order.indexOf("guard"));
  assert.ok(order.indexOf("guard") < order.indexOf("local.purge"));
  assert.ok(order.indexOf("local.purge") < order.indexOf("hold.markDeleted"));
  assert.equal(order.includes("hold.release"), false, "a deleted teamspace stays out of the lists");
  assert.equal(order.includes("hold.bringBack"), false);
});

test("a commit the server refuses brings the teamspace back where it stands", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps, localSpace } = makeHarness();
  deps.spaces.remove = async () => {
    throw new CloudApiError("Nope", 403);
  };
  const hold = createSpaceActions(deps).holdSpaceDelete(localSpace);

  const result = await hold.commit();

  assert.equal(result.success, false);
  assert.deepEqual(result.failure, { kind: "notAllowed" });
  assert.equal(namesOf(calls).includes("local.purge"), false);
  assert.deepEqual(calls.slice(-2), [
    ["hold.release", 7, "cloud-space-1"],
    ["hold.bringBack", false],
  ]);
});

test("a commit that throws reads as a failure and still lets go of the hold", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  deps.local.purgeSpace = async () => {
    throw new Error("disk");
  };
  const hold = createSpaceActions(deps).holdSpaceDelete(localSpace);

  const result = await hold.commit();

  assert.deepEqual(result, { success: false, error: "disk", failure: { kind: "failed" } });
  assert.deepEqual(calls.at(-1), ["hold.bringBack", false]);
});

test("a commit after another account signed in sends nothing", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  let generation = 1;
  deps.deleteHold.accountGeneration = () => generation;
  const hold = createSpaceActions(deps).holdSpaceDelete(localSpace);
  generation = 2;

  assert.equal(await hold.commit(), null);

  assert.equal(namesOf(calls).includes("space.remove"), false);
  assert.equal(namesOf(calls).includes("local.purge"), false);
});

test("Try again holds for the same account, and not after another signed in", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  let generation = 1;
  deps.deleteHold.accountGeneration = () => generation;
  deps.spaces.remove = async () => {
    throw new Error("offline");
  };
  const hold = createSpaceActions(deps).holdSpaceDelete(localSpace);
  await hold.commit();

  const retry = hold.again();
  assert.ok(retry);
  deps.spaces.remove = async (spaceId) => calls.push(["space.remove", spaceId]);
  assert.equal((await retry.commit()).success, true);

  generation = 2;
  assert.equal(hold.again(), null);
});

test("Undo after someone else's delete reached this device claims nothing", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeHarness();
  const hold = createSpaceActions(deps).holdSpaceDelete(localSpace);
  deps.local.getSpaces = async () => [];

  assert.equal(await hold.undo(), false);

  assert.equal(namesOf(calls).includes("hold.bringBack"), false);
});

test("a view that can't be brought back doesn't lose the outcome", async (t) => {
  const { createSpaceActions } = await load();
  t.mock.method(console, "error", () => {});
  const { deps, localSpace } = makeHarness();
  deps.deleteHold.hide = () => async () => {
    throw new Error("disk");
  };

  assert.equal(await createSpaceActions(deps).holdSpaceDelete(localSpace).undo(), true);

  deps.spaces.remove = async () => {
    throw new Error("offline");
  };
  const failed = await createSpaceActions(deps).holdSpaceDelete(localSpace).commit();
  assert.equal(failed.success, false);
});

test("a delete reports how many notes moved to Personal", async () => {
  const { createSpaceActions } = await load();
  const { deps, localSpace } = makeHarness();
  deps.local.purgeSpace = async () => ({ success: true, relocatedCount: 4 });

  const result = await createSpaceActions(deps).deleteSpace(localSpace);

  assert.equal(result.relocatedCount, 4);
});

test("a space a sync pass purged first counts as deleted", async () => {
  const { createSpaceActions } = await load();
  const { deps, localSpace } = makeHarness();
  deps.local.purgeSpace = async () => ({ success: false, error: "Space not found" });
  deps.local.getSpaces = async () => [];

  assert.deepEqual(await createSpaceActions(deps).deleteSpace(localSpace), { success: true });
});

test("a purge that failed on a space still here is reported", async () => {
  const { createSpaceActions } = await load();
  const { deps, localSpace } = makeHarness();
  deps.local.purgeSpace = async () => ({ success: false, error: "disk" });

  const result = await createSpaceActions(deps).deleteSpace(localSpace);

  assert.deepEqual(result, { success: false, error: "disk" });
});

test("a write the server accepted isn't failed by a refresh that fails", async (t) => {
  const { createSpaceActions } = await load();
  t.mock.method(console, "error", () => {});
  const writes = {
    joinSpace: (actions) => actions.joinSpace("cloud-space-1"),
    addPeopleToSpace: (actions) => actions.addPeopleToSpace("cloud-space-1", ["user-1"]),
    leaveSpace: (actions, space) => actions.leaveSpace(space, "me"),
    setSpaceMemberRole: (actions, space) => actions.setSpaceMemberRole(space, "user-1", "admin"),
    removeSpaceMember: (actions, space) => actions.removeSpaceMember(space, "user-1"),
    assignTeamToSpace: (actions, space) => actions.assignTeamToSpace(space, "team-1"),
    setSpaceTeamAccess: (actions, space) => actions.setSpaceTeamAccess(space, "team-1", "admin"),
    unassignTeamFromSpace: (actions, space) => actions.unassignTeamFromSpace(space, "team-1"),
    setSpaceAccessFlags: (actions) =>
      actions.setSpaceAccessFlags("cloud-space-1", { is_open: true }),
    leaveTeam: (actions) => actions.leaveTeam("team-1", "me"),
    removeTeamMember: (actions) => actions.removeTeamMember("team-1", "user-1"),
    setTeamMemberRole: (actions) => actions.setTeamMemberRole("team-1", "user-1", "admin"),
  };
  for (const [name, write] of Object.entries(writes)) {
    const { calls, deps, localSpace } = makeHarness();
    deps.spaces.mySpaces = async () => {
      throw new Error("offline");
    };
    await write(createSpaceActions(deps), localSpace);
    assert.deepEqual(
      calls.at(-1),
      ["sync", "manual"],
      `${name} leaves the mirror to the sync pass`
    );
  }
});

test("a refused write still rejects", async () => {
  const { createSpaceActions } = await load();
  const { deps } = makeHarness();
  const refusal = new Error("Nope");
  deps.spaces.join = async () => {
    throw refusal;
  };

  await assert.rejects(createSpaceActions(deps).joinSpace("cloud-space-1"), refusal);
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

test("a space found gone asks the sync pass to catch the mirror up", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeHarness();
  const actions = createSpaceActions(deps);

  actions.requestSpacesResync();

  assert.deepEqual(calls, [["sync", "manual"]]);
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

test("a gateway error can hide a create that went through, so it looks", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps, localSpace } = makeHarness();
  deps.spaces.create = async () => {
    throw new CloudApiError("Gateway timeout", 504);
  };
  deps.spaces.mySpaces = async () => [ownCreate()];

  const space = await createSpaceActions(deps).createSpace(
    "workspace-1",
    { name: "Roadmap" },
    { memberIds: [], teamIds: [] }
  );

  assert.equal(space, localSpace);
});

test("main's 503 carries a code and can hide a create that went through too", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps, localSpace } = makeHarness();
  deps.spaces.create = async () => {
    throw new CloudApiError("Service temporarily unavailable", 503, "SERVER_ERROR");
  };
  deps.spaces.mySpaces = async () => [ownCreate()];

  const space = await createSpaceActions(deps).createSpace(
    "workspace-1",
    { name: "Roadmap" },
    { memberIds: [], teamIds: [] }
  );

  assert.equal(space, localSpace);
});

test("a lost create the lookup couldn't settle is settled by the retry's taken name", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps, localSpace } = makeHarness();
  const lost = new CloudApiError("Network error", 0);
  deps.spaces.create = async () => {
    throw lost;
  };
  deps.spaces.mySpaces = async () => {
    throw new Error("still offline");
  };
  const actions = createSpaceActions(deps);
  const input = { name: "Roadmap" };
  const access = { memberIds: [], teamIds: [] };

  await assert.rejects(actions.createSpace("workspace-1", input, access), lost);

  // Back online: the first attempt had gone through, so its name is now taken, by itself.
  deps.spaces.create = async () => {
    throw new CloudApiError("Name taken", 409, "space_name_taken");
  };
  deps.spaces.mySpaces = async () => [ownCreate()];

  assert.equal(await actions.createSpace("workspace-1", input, access), localSpace);
});

// The earlier teamspace has none of what the retry changed, so taking it would drop that unseen.
for (const [change, retryInput, retryAccess] of [
  ["an extra member", {}, { memberIds: ["user-1", "user-2"], teamIds: [] }],
  ["a group", {}, { memberIds: ["user-1"], teamIds: ["team-1"] }],
  ["Open", { is_open: true }, { memberIds: ["user-1"], teamIds: [] }],
  ["a description", { description: "Plans" }, { memberIds: ["user-1"], teamIds: [] }],
]) {
  test(`a retry that adds ${change} doesn't take the earlier teamspace for its own`, async () => {
    const { createSpaceActions } = await load();
    const { CloudApiError } = await import("../../src/services/cloudApi.ts");
    const { deps } = makeHarness();
    deps.spaces.create = async () => {
      throw new CloudApiError("Network error", 0);
    };
    deps.spaces.mySpaces = async () => {
      throw new Error("still offline");
    };
    const actions = createSpaceActions(deps);
    const input = { name: "Roadmap" };
    await assert.rejects(
      actions.createSpace("workspace-1", input, { memberIds: ["user-1"], teamIds: [] })
    );

    const taken = new CloudApiError("Name taken", 409, "space_name_taken");
    deps.spaces.create = async () => {
      throw taken;
    };
    deps.spaces.mySpaces = async () => [ownCreate()];

    await assert.rejects(
      actions.createSpace("workspace-1", { ...input, ...retryInput }, retryAccess),
      (error) => error === taken
    );
  });
}

test("a changed retry whose answer is lost too doesn't take the earlier teamspace", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeHarness();
  const lost = new CloudApiError("Network error", 0);
  deps.spaces.create = async () => {
    throw lost;
  };
  deps.spaces.mySpaces = async () => {
    throw new Error("still offline");
  };
  const actions = createSpaceActions(deps);
  const access = { memberIds: [], teamIds: [] };
  await assert.rejects(actions.createSpace("workspace-1", { name: "Roadmap" }, access));

  deps.spaces.mySpaces = async () => [ownCreate()];

  await assert.rejects(
    actions.createSpace("workspace-1", { name: "Roadmap", is_open: true }, access),
    (error) => error === lost
  );
});

test("the retry matches its lost create as the server compares names", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps, localSpace } = makeHarness();
  deps.spaces.create = async () => {
    throw new CloudApiError("Network error", 0);
  };
  deps.spaces.mySpaces = async () => {
    throw new Error("still offline");
  };
  const actions = createSpaceActions(deps);
  const access = { memberIds: [], teamIds: [] };
  await assert.rejects(actions.createSpace("workspace-1", { name: "Roadmap" }, access));

  deps.spaces.create = async () => {
    throw new CloudApiError("Name taken", 409, "space_name_taken");
  };
  deps.spaces.mySpaces = async () => [ownCreate()];

  const space = await actions.createSpace("workspace-1", { name: "  ROADMAP " }, access);
  assert.equal(space, localSpace);
});

test("an unsettled create expires, so a much later taken name is a real one", async (t) => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeHarness();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  deps.spaces.create = async () => {
    throw new CloudApiError("Network error", 0);
  };
  deps.spaces.mySpaces = async () => {
    throw new Error("still offline");
  };
  const actions = createSpaceActions(deps);
  const access = { memberIds: [], teamIds: [] };
  await assert.rejects(actions.createSpace("workspace-1", { name: "Roadmap" }, access));

  t.mock.timers.tick(61 * 60_000);
  const taken = new CloudApiError("Name taken", 409, "space_name_taken");
  deps.spaces.create = async () => {
    throw taken;
  };
  let looked = false;
  deps.spaces.mySpaces = async () => {
    looked = true;
    return [ownCreate()];
  };

  await assert.rejects(actions.createSpace("workspace-1", { name: "Roadmap" }, access), taken);
  assert.equal(looked, false);
});

test("a lookup that answered settles it: a later taken name is a real one", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeHarness();
  const lost = new CloudApiError("Network error", 0);
  deps.spaces.create = async () => {
    throw lost;
  };
  deps.spaces.mySpaces = async () => [];
  const actions = createSpaceActions(deps);
  const input = { name: "Roadmap" };
  const access = { memberIds: [], teamIds: [] };

  await assert.rejects(actions.createSpace("workspace-1", input, access), lost);

  const taken = new CloudApiError("Name taken", 409, "space_name_taken");
  deps.spaces.create = async () => {
    throw taken;
  };
  let looked = false;
  deps.spaces.mySpaces = async () => {
    looked = true;
    return [ownCreate()];
  };

  await assert.rejects(actions.createSpace("workspace-1", input, access), taken);
  assert.equal(looked, false);
});

test("a name-taken refusal never looks", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");

  // The server answered, so there is nothing lost to find; a same-name space of the caller's
  // would be the very one that made the name taken.
  for (const refusal of [
    new CloudApiError("Name taken", 409, "space_name_taken"),
    new CloudApiError("Name taken", 409),
    new CloudApiError("Bad request", 400),
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

test("leaving a team that was deleted meanwhile says so, after the mirror catches up", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeHarness();
  deps.teams.removeMember = async () => {
    throw new CloudApiError("Team not found", 404);
  };

  await assert.rejects(createSpaceActions(deps).leaveTeam("team-1", "me"), {
    message: "Team not found",
  });

  assert.ok(
    calls.some(([name]) => name === "space.mySpaces"),
    "the mirror is still refreshed"
  );
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

// Teams: create with a lost answer, and the held delete.

const ownTeam = (overrides = {}) => ({
  id: "team-9",
  workspace_id: "workspace-1",
  name: "Sales",
  my_role: "admin",
  my_direct_role: "admin",
  created_at: minutesAgo(1),
  ...overrides,
});

function makeTeamHarness() {
  const harness = makeHarness();
  const { calls, deps } = harness;
  deps.teams.list = async (workspaceId) => {
    calls.push(["team.list", workspaceId]);
    return [];
  };
  deps.teams.create = async (workspaceId, input) => {
    calls.push(["team.create", workspaceId, input]);
    return ownTeam();
  };
  deps.teams.update = async (teamId, updates) => {
    calls.push(["team.update", teamId, updates]);
    return ownTeam({ ...updates });
  };
  deps.teams.addMembers = async (teamId, userIds) => {
    calls.push(["team.addMembers", teamId, userIds]);
    return { added: userIds, already_members: [] };
  };
  deps.teamDeleteHold = {
    hide: (teamId) => calls.push(["teamHold.hide", teamId]),
    release: (teamId) => calls.push(["teamHold.release", teamId]),
  };
  return harness;
}

const teamInput = { name: "Sales", memberIds: ["u1"] };

test("createTeam sends the founding members in one request", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();

  const team = await createSpaceActions(deps).createTeam("workspace-1", teamInput);

  assert.equal(team.id, "team-9");
  assert.deepEqual(calls[0], ["team.create", "workspace-1", { name: "Sales", member_ids: ["u1"] }]);
  assert.equal(
    namesOf(calls).includes("team.addMembers"),
    false,
    "a normal create adds nobody again"
  );
});

test("a team recovered after a lost answer gets this try's people through the batch route", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeTeamHarness();
  deps.teams.create = async () => {
    throw new CloudApiError("Cloud API request failed", 0);
  };
  deps.teams.list = async () => [ownTeam()];

  const team = await createSpaceActions(deps).createTeam("workspace-1", {
    name: "Sales",
    memberIds: ["u1", "u2"],
  });

  assert.equal(team.id, "team-9");
  assert.deepEqual(
    calls.find(([name]) => name === "team.addMembers"),
    ["team.addMembers", "team-9", ["u1", "u2"]]
  );
});

test("a failed add on a recovered team throws, and the next try can recover it again", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeTeamHarness();
  deps.teams.create = async () => {
    throw new CloudApiError("Cloud API request failed", 0);
  };
  deps.teams.list = async () => [ownTeam()];
  const failure = new Error("offline");
  deps.teams.addMembers = async () => {
    throw failure;
  };
  const actions = createSpaceActions(deps);
  await assert.rejects(actions.createTeam("workspace-1", teamInput), (error) => error === failure);

  // The name is now taken by the team the first try made.
  deps.teams.create = async () => {
    throw new CloudApiError("Taken", 409, "team_name_taken");
  };
  deps.teams.addMembers = async () => ({ added: ["u1"], already_members: [] });
  const team = await actions.createTeam("workspace-1", teamInput);
  assert.equal(team.id, "team-9");
});

test("repeated failed adds on a recovered team keep measuring from the first try", async (t) => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeTeamHarness();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const made = ownTeam();
  deps.teams.create = async () => {
    throw new CloudApiError("Cloud API request failed", 0);
  };
  deps.teams.list = async () => [made];
  deps.teams.addMembers = async () => {
    throw new Error("offline");
  };
  const actions = createSpaceActions(deps);
  await assert.rejects(actions.createTeam("workspace-1", teamInput));

  deps.teams.create = async () => {
    throw new CloudApiError("Taken", 409, "team_name_taken");
  };
  // The team was made just before the first try. Marking each failure with its own time would put
  // the second retry outside the lost-create window of that creation.
  t.mock.timers.tick(5 * 60_000);
  await assert.rejects(actions.createTeam("workspace-1", teamInput));
  t.mock.timers.tick(5 * 60_000);
  deps.teams.addMembers = async () => ({ added: ["u1"], already_members: [] });
  const team = await actions.createTeam("workspace-1", teamInput);
  assert.equal(team.id, "team-9");
});

test("a retried create that finds its own team reports success", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeTeamHarness();
  const found = ownTeam();
  deps.teams.create = async () => {
    throw new CloudApiError("Cloud API request failed", 0);
  };
  deps.teams.list = async () => [ownTeam({ id: "team-1", name: "Other" }), found];

  const team = await createSpaceActions(deps).createTeam("workspace-1", {
    name: " sales ",
    memberIds: [],
  });

  assert.equal(team, found);
});

test("after a lost answer, a same-name team that isn't the caller's own stays a refusal", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeTeamHarness();
  const lost = new CloudApiError("Cloud API request failed", 0);
  deps.teams.create = async () => {
    throw lost;
  };
  // An admin through the workspace, not through a row of their own: not the creator.
  deps.teams.list = async () => {
    calls.push(["team.list.read"]);
    return [ownTeam({ my_direct_role: null, my_role: "admin" })];
  };

  await assert.rejects(
    createSpaceActions(deps).createTeam("workspace-1", teamInput),
    (error) => error === lost
  );
  assert.ok(namesOf(calls).includes("team.list.read"), "the lookup ran");
});

test("on an unsettled retry, a same-name team that isn't the caller's own stays a refusal", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeTeamHarness();
  const lost = new CloudApiError("Network error", 0);
  deps.teams.create = async () => {
    throw lost;
  };
  deps.teams.list = async () => {
    throw new CloudApiError("Network error", 0);
  };
  const actions = createSpaceActions(deps);
  await assert.rejects(actions.createTeam("workspace-1", teamInput), (error) => error === lost);

  const taken = new CloudApiError("Taken", 409, "team_name_taken");
  deps.teams.create = async () => {
    throw taken;
  };
  deps.teams.list = async () => {
    calls.push(["team.list.read"]);
    return [ownTeam({ my_direct_role: null, my_role: "admin" })];
  };
  await assert.rejects(actions.createTeam("workspace-1", teamInput), (error) => error === taken);
  assert.ok(namesOf(calls).includes("team.list.read"), "the lookup ran");
});

test("a lost answer next to an old team of the caller's doesn't adopt it", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeTeamHarness();
  const lost = new CloudApiError("Cloud API request failed", 0);
  deps.teams.create = async () => {
    throw lost;
  };
  deps.teams.list = async () => [ownTeam({ created_at: minutesAgo(6) })];

  await assert.rejects(
    createSpaceActions(deps).createTeam("workspace-1", teamInput),
    (error) => error === lost
  );
});

test("a failed lookup leaves it unsettled, so the retry's taken name settles it", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeTeamHarness();
  const lost = new CloudApiError("Network error", 0);
  deps.teams.create = async () => {
    throw lost;
  };
  deps.teams.list = async () => {
    throw new CloudApiError("Network error", 0);
  };
  const actions = createSpaceActions(deps);
  await assert.rejects(actions.createTeam("workspace-1", teamInput), (error) => error === lost);

  deps.teams.create = async () => {
    throw new CloudApiError("Taken", 409, "team_name_taken");
  };
  deps.teams.list = async () => [ownTeam()];
  const team = await actions.createTeam("workspace-1", teamInput);

  assert.equal(team.id, "team-9");
});

test("planRequired isn't treated as a lost answer", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeTeamHarness();
  const refusal = new CloudApiError("Upgrade", 403, "team_plan_required");
  deps.teams.create = async () => {
    throw refusal;
  };

  await assert.rejects(
    createSpaceActions(deps).createTeam("workspace-1", teamInput),
    (error) => error === refusal
  );
  assert.equal(namesOf(calls).includes("team.list"), false);
});

test("unsettled team and teamspace creates of one name don't settle each other", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { deps } = makeTeamHarness();
  const lost = new CloudApiError("Network error", 0);
  deps.spaces.create = async () => {
    throw lost;
  };
  deps.spaces.mySpaces = async () => {
    throw lost;
  };
  const actions = createSpaceActions(deps);
  await assert.rejects(
    actions.createSpace("workspace-1", { name: "Sales" }, { memberIds: [], teamIds: [] }),
    (error) => error === lost
  );

  const taken = new CloudApiError("Taken", 409, "team_name_taken");
  deps.teams.create = async () => {
    throw taken;
  };
  deps.teams.list = async () => [ownTeam()];
  await assert.rejects(actions.createTeam("workspace-1", teamInput), (error) => error === taken);
});

test("addPeopleToTeam returns the server's lists and refreshes the mirror", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();

  const result = await createSpaceActions(deps).addPeopleToTeam("team-9", ["u1", "u2"]);

  assert.deepEqual(result, { added: ["u1", "u2"], already_members: [] });
  assert.ok(namesOf(calls).includes("mirror.upsert"));
});

test("renameTeam sends the name and refreshes the mirror", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();

  const team = await createSpaceActions(deps).renameTeam("team-9", "Revenue");

  assert.equal(team.name, "Revenue");
  assert.deepEqual(calls[0], ["team.update", "team-9", { name: "Revenue" }]);
  assert.ok(namesOf(calls).includes("mirror.upsert"));
});

test("a held team delete sends nothing until commit", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();

  createSpaceActions(deps).holdTeamDelete({ id: "team-9", name: "Sales" });

  assert.deepEqual(calls, [["teamHold.hide", "team-9"]]);
});

test("Undo on a team delete sends nothing", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();
  const hold = createSpaceActions(deps).holdTeamDelete({ id: "team-9", name: "Sales" });

  assert.equal(await hold.undo(), true);
  assert.equal(await hold.commit(), null);
  assert.equal(await hold.undo(), false);

  assert.deepEqual(calls, [
    ["teamHold.hide", "team-9"],
    ["teamHold.release", "team-9"],
  ]);
});

test("a committed team delete sends once, refreshes and syncs", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();
  const hold = createSpaceActions(deps).holdTeamDelete({ id: "team-9", name: "Sales" });

  assert.deepEqual(await hold.commit(), { success: true });
  assert.equal(await hold.undo(), false);

  const order = namesOf(calls);
  assert.equal(order.filter((name) => name === "team.remove").length, 1);
  assert.ok(order.includes("mirror.upsert"));
  assert.deepEqual(calls.at(-1), ["sync", "manual"]);
  assert.equal(order.includes("teamHold.release"), false, "a deleted team stays out of the lists");
});

test("a committed team delete reads the workspace's people again, in the team's workspace", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();
  const hold = createSpaceActions(deps).holdTeamDelete({
    id: "team-9",
    name: "Sales",
    workspace_id: "workspace-7",
  });

  assert.deepEqual(await hold.commit(), { success: true });

  assert.deepEqual(
    calls.filter(([name]) => name === "people.refresh"),
    [["people.refresh", "workspace-7"]]
  );
});

test("a failed people read after a team delete leaves the delete a success", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();
  deps.refreshWorkspaceRoster = async () => {
    throw new Error("offline");
  };
  const hold = createSpaceActions(deps).holdTeamDelete({
    id: "team-9",
    name: "Sales",
    workspace_id: "workspace-7",
  });

  assert.deepEqual(await hold.commit(), { success: true });
  assert.deepEqual(calls.at(-1), ["sync", "manual"]);
});

test("neither an Undo nor a refused team delete reads the people again", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeTeamHarness();
  const team = { id: "team-9", name: "Sales", workspace_id: "workspace-7" };
  const undone = createSpaceActions(deps).holdTeamDelete(team);
  await undone.undo();
  await undone.commit();
  deps.teams.remove = async () => {
    throw new CloudApiError("Nope", 403);
  };
  await createSpaceActions(deps).holdTeamDelete(team).commit();

  assert.equal(namesOf(calls).includes("people.refresh"), false);
});

test("a team the server says is gone counts as deleted", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeTeamHarness();
  deps.teams.remove = async () => {
    throw new CloudApiError("Team not found", 404);
  };
  const hold = createSpaceActions(deps).holdTeamDelete({ id: "team-9", name: "Sales" });

  assert.deepEqual(await hold.commit(), { success: true });
  assert.ok(namesOf(calls).includes("mirror.upsert"));
  assert.equal(namesOf(calls).includes("teamHold.release"), false);
});

test("a bare 404 proves nothing: the row comes back and Try again is offered", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeTeamHarness();
  deps.teams.remove = async () => {
    throw new CloudApiError("Not found", 404);
  };
  const hold = createSpaceActions(deps).holdTeamDelete({ id: "team-9", name: "Sales" });

  const result = await hold.commit();

  assert.equal(result.success, false);
  assert.deepEqual(calls.at(-1), ["teamHold.release", "team-9"]);
  assert.ok(hold.again());
});

test("a failed team delete returns the row and offers again", async () => {
  const { createSpaceActions } = await load();
  const { CloudApiError } = await import("../../src/services/cloudApi.ts");
  const { calls, deps } = makeTeamHarness();
  deps.teams.remove = async () => {
    throw new CloudApiError("Nope", 403);
  };
  const hold = createSpaceActions(deps).holdTeamDelete({ id: "team-9", name: "Sales" });

  const result = await hold.commit();

  assert.equal(result.success, false);
  assert.deepEqual(result.failure, { kind: "notAllowed" });
  assert.deepEqual(calls.at(-1), ["teamHold.release", "team-9"]);

  deps.teams.remove = async (teamId) => calls.push(["team.remove", teamId]);
  const retry = hold.again();
  assert.ok(retry);
  assert.deepEqual(calls.at(-1), ["teamHold.hide", "team-9"]);
  assert.equal((await retry.commit()).success, true);
});

test("another account's team hold sends nothing", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();
  let generation = 1;
  deps.deleteHold.accountGeneration = () => generation;
  const hold = createSpaceActions(deps).holdTeamDelete({ id: "team-9", name: "Sales" });
  generation = 2;

  assert.equal(await hold.commit(), null);
  assert.equal(hold.again(), null);
  assert.equal(namesOf(calls).includes("team.remove"), false);
});

test("leaving the page sends open team holds too", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();
  const actions = createSpaceActions(deps);
  actions.holdTeamDelete({ id: "team-9", name: "Sales" });

  actions.commitHeldDeletes();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(namesOf(calls).filter((name) => name === "team.remove").length, 1);
});

test("a second commit on a team hold sends nothing more", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps } = makeTeamHarness();
  const hold = createSpaceActions(deps).holdTeamDelete({ id: "team-9", name: "Sales" });

  await hold.commit();
  assert.equal(await hold.commit(), null);

  assert.equal(namesOf(calls).filter((name) => name === "team.remove").length, 1);
});

test("leaving the page sends a space hold and a team hold, one request each", async () => {
  const { createSpaceActions } = await load();
  const { calls, deps, localSpace } = makeTeamHarness();
  const actions = createSpaceActions(deps);
  actions.holdSpaceDelete(localSpace);
  actions.holdTeamDelete({ id: "team-9", name: "Sales" });

  actions.commitHeldDeletes();
  await new Promise((resolve) => setImmediate(resolve));
  actions.commitHeldDeletes();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(namesOf(calls).filter((name) => name === "space.remove").length, 1);
  assert.equal(namesOf(calls).filter((name) => name === "team.remove").length, 1);
});
