// The shared dictionary pass of SyncService, driven through its public entry
// points with the IPC mirror and the cloud routes faked (harness/
// sharedDictionaryFakes.js). The real SharedDictionaryService, stores and
// hint selector run unchanged.

const test = require("node:test");
const assert = require("node:assert/strict");

const harness = require("../helpers/harness/browserGlobals.js");
const {
  WORKSPACE_SCOPE,
  spaceScope,
  createSharedDictionaryDb,
  createSharedDictionaryCloud,
} = require("../helpers/harness/sharedDictionaryFakes.js");

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const SPACE_B = "33333333-3333-4333-8333-333333333333";
const LIST = "/api/shared-dictionary/list";
const HIDES = "/api/shared-dictionary/hides";
const ENTRIES_CURSOR = `lastSyncedAt.sharedDictionary.${W1}`;
const HIDES_CURSOR = `lastSyncedAt.sharedDictionaryHides.${W1}`;

const flush = () => new Promise((resolve) => setImmediate(resolve));

function modules() {
  return {
    SyncService: require("../../src/services/SyncService.ts").SyncService,
    useWorkspaceStore: require("../../src/stores/workspaceStore.ts").useWorkspaceStore,
    useSharedDictionaryStore: require("../../src/stores/sharedDictionaryStore.ts")
      .useSharedDictionaryStore,
    useSettingsStore: require("../../src/stores/settingsStore.ts").useSettingsStore,
    takeSharedDictionaryArrival: require("../../src/stores/sharedDictionaryStore.ts")
      .takeSharedDictionaryArrival,
  };
}

async function setup(t, { workspaceId = W1, signedIn = true } = {}) {
  harness.resetBrowserGlobals();
  harness.installBrowserGlobals();
  if (signedIn) harness.localStorage.setItem("isSignedIn", "true");

  const db = createSharedDictionaryDb();
  const cloud = createSharedDictionaryCloud();
  // What the pass rebroadcasts to every window through the main process.
  const syncEvents = [];
  harness.window.electronAPI = {
    ...db.api,
    emitSyncEvent: async (name, payload) => {
      syncEvents.push({ name, payload });
      return { success: true };
    },
    cloudApiRequest: cloud.cloudApiRequest,
    authGetTokenState: async () => ({ token: "token-harness", generation: 1 }),
    setSharedDictionaryHints: async () => {},
  };
  await harness.establishValidatedAuth();

  const mods = modules();
  mods.useSharedDictionaryStore.setState({ status: "ready" });
  mods.useWorkspaceStore.setState({
    activeWorkspaceId: null,
    loaded: false,
    error: false,
    workspaces: [],
  });
  if (workspaceId) mods.useWorkspaceStore.getState().setActiveWorkspaceId(workspaceId);
  await flush();

  const service = new mods.SyncService();
  t.after(() => harness.stopSyncTimers(service));
  const hints = () => mods.useSettingsStore.getState().sharedDictionaryHints;
  const eventsNamed = (name) =>
    syncEvents.filter((event) => event.name === name).map((event) => event.payload);
  const arrivals = () => eventsNamed("shared-dictionary-arrived");
  const changes = () => eventsNamed("shared-dictionary-changed");
  return { ...mods, db, cloud, service, hints, arrivals, changes, syncEvents };
}

const query = (request) => Object.fromEntries(request.query.entries());

test("first pass pages the snapshot then switches to delta cursors", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  const rows = cloud.add(
    W1,
    Array.from({ length: 250 }, (_, index) => `Word${index}`),
    { created_at: "2026-10-20T10:00:00.000Z", updated_at: "2026-10-20T10:00:00.000Z" }
  );
  cloud.hide(W1, rows[3].id, "2026-10-20T11:00:00.000Z");

  await service.syncSharedDictionaryNow();

  const [first, second] = cloud.requestsTo(LIST).map(query);
  assert.deepEqual(first, { workspace_id: W1, limit: "200" });
  assert.equal(second.cursor, rows[199].created_at);
  assert.equal(second.cursor_id, rows[199].id);
  assert.equal(second.since, undefined);
  const replaced = db.callsNamed("replaceSharedDictionary");
  assert.equal(replaced.length, 1, "the snapshot is written once");
  assert.equal(replaced[0].entries.length, 250);
  assert.deepEqual(replaced[0].meta.scopes, [WORKSPACE_SCOPE]);
  assert.equal(db.callsNamed("applySharedDictionaryPull").length, 0);
  assert.deepEqual(db.callsNamed("replaceSharedDictionaryHides")[0].hidden, [
    { entryId: rows[3].id, updatedAt: "2026-10-20T11:00:00.000Z" },
  ]);
  assert.equal(harness.localStorage.getItem(ENTRIES_CURSOR), "2026-10-20T12:00:00.000Z");
  assert.equal(harness.localStorage.getItem(HIDES_CURSOR), "2026-10-20T12:00:00.000Z");
  assert.equal(ctx.hints().workspace.length, 249, "the hidden word does not apply");

  cloud.add(W1, ["Late"], {
    created_at: "2026-10-20T12:05:00.000Z",
    updated_at: "2026-10-20T12:05:00.000Z",
  });
  cloud.setServerTime("2026-10-20T12:10:00.000Z");
  await service.syncSharedDictionaryNow();

  const delta = query(cloud.requestsTo(LIST)[2]);
  assert.equal(delta.since, "2026-10-20T11:59:50.000Z");
  assert.equal(delta.cursor, undefined);
  const hidesDelta = query(cloud.requestsTo(HIDES)[1]);
  assert.equal(hidesDelta.since, "2026-10-20T11:59:50.000Z");
  assert.equal(db.callsNamed("replaceSharedDictionary").length, 1);
  assert.equal(db.callsNamed("applySharedDictionaryPull").length, 1);
  assert.equal(db.callsNamed("applySharedDictionaryHides").length, 1);
  assert.equal(harness.localStorage.getItem(ENTRIES_CURSOR), "2026-10-20T12:10:00.000Z");
  assert.ok(ctx.hints().workspace.includes("Late"));
});

test("delta passes overlap the stored cursor by 10 seconds", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant", "Orukeet"], {
    created_at: "2026-10-20T11:59:55.000Z",
    updated_at: "2026-10-20T11:59:55.000Z",
  });
  await service.syncSharedDictionaryNow();
  harness.localStorage.setItem(ENTRIES_CURSOR, "2026-10-20T12:00:00.000Z");
  const before = await db.api.getSharedDictionary(W1);

  await service.syncSharedDictionaryNow();

  const delta = query(cloud.requestsTo(LIST).at(-1));
  assert.equal(delta.since, "2026-10-20T11:59:50.000Z");
  assert.equal(delta.since_id, undefined, "the overlap never sends since_id");
  const pull = db.callsNamed("applySharedDictionaryPull").at(-1);
  assert.equal(pull.upserts.length, 2, "rows inside the overlap are re-read");
  const after = await db.api.getSharedDictionary(W1);
  assert.deepEqual(after.entries, before.entries, "re-applied rows change nothing");
  assert.deepEqual(after.hiddenIds, before.hiddenIds);
});

test("NOT_MEMBER clears the workspace and its cursors", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();
  assert.deepEqual(ctx.hints().workspace, ["Qdrant"]);

  cloud.failNext(LIST, { status: 404, code: "SHARED_DICTIONARY_NOT_MEMBER" });
  await service.syncSharedDictionaryNow();

  assert.deepEqual(db.callsNamed("clearSharedDictionary").at(-1), {
    name: "clearSharedDictionary",
    workspaceId: W1,
  });
  assert.equal(db.workspaces.has(W1), false);
  assert.equal(harness.localStorage.getItem(ENTRIES_CURSOR), null);
  assert.equal(harness.localStorage.getItem(HIDES_CURSOR), null);
  assert.deepEqual(ctx.hints(), { space: [], workspace: [] });
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "noAccess");
  assert.deepEqual(ctx.changes().at(-1), { workspaceId: W1 }, "other windows reload");
  assert.deepEqual(JSON.parse(harness.localStorage.getItem("sharedDictionaryAccess")), {
    [W1]: "noAccess",
  });

  // Access comes back: the next pass that succeeds says so.
  await service.syncSharedDictionaryNow();
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "ready");
  assert.equal(harness.localStorage.getItem("sharedDictionaryAccess"), null);
  assert.deepEqual(ctx.hints().workspace, ["Qdrant"]);
});

test("a member who stays locked out doesn't count as moved work", async (t) => {
  const ctx = await setup(t);
  const { cloud, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();

  cloud.failNext(LIST, { status: 403, code: "SSO_REQUIRED" });
  service.teamPassMovedWork = false;
  await service.syncSharedDictionaryNow();
  assert.equal(service.teamPassMovedWork, true, "the first refusal cleared the mirror");
  assert.equal(ctx.changes().length, 2);

  cloud.failNext(LIST, { status: 403, code: "SSO_REQUIRED" });
  service.teamPassMovedWork = false;
  await service.syncSharedDictionaryNow();
  assert.equal(service.teamPassMovedWork, false, "nothing was left to clear");
  assert.equal(ctx.changes().length, 2, "and nothing to reload");
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "ssoRequired");
});

test("an access status belongs to the workspace it was refused for", async (t) => {
  const ctx = await setup(t);
  const { cloud, service } = ctx;
  cloud.failNext(LIST, { status: 403, code: "SSO_REQUIRED" });
  await service.syncSharedDictionaryNow();
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "ssoRequired");

  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W2);
  await flush();
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "ready");

  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "ssoRequired", "until a pass");
});

test("SSO_REQUIRED clears the workspace like NOT_MEMBER", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();

  cloud.failNext(LIST, { status: 403, code: "SSO_REQUIRED" });
  await service.syncSharedDictionaryNow();

  assert.equal(db.workspaces.has(W1), false);
  assert.equal(harness.localStorage.getItem(ENTRIES_CURSOR), null);
  assert.deepEqual(ctx.hints(), { space: [], workspace: [] });
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "ssoRequired");
});

test("plain 404 marks unavailable without throwing", async (t) => {
  const ctx = await setup(t);
  const errors = t.mock.method(console, "error", () => {});
  ctx.cloud.failNext(LIST, { status: 404 });

  await ctx.service.syncSharedDictionaryNow();

  assert.equal(ctx.useSharedDictionaryStore.getState().status, "unavailable");
  assert.equal(harness.localStorage.getItem("sharedDictionaryCapability"), "false");
  assert.equal(errors.mock.callCount(), 0, "an older API is not an error");
  assert.equal(ctx.db.calls.length, 0);

  // The rest of the session doesn't ask again.
  ctx.cloud.add(W1, ["Qdrant"]);
  await ctx.service.syncSharedDictionaryNow();
  assert.equal(ctx.cloud.requestsTo(LIST).length, 1);
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "unavailable");

  // Once the routes exist, the next session marks them available again.
  const next = new ctx.SyncService();
  t.after(() => harness.stopSyncTimers(next));
  await next.syncSharedDictionaryNow();
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "ready");
  assert.equal(harness.localStorage.getItem("sharedDictionaryCapability"), "true");
});

test("a 404 is asked again once the account changes", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.failNext(LIST, { status: 404 });
  await ctx.service.syncSharedDictionaryNow();
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "unavailable");

  harness.window.electronAPI.authGetTokenState = async () => ({
    token: "token-next",
    generation: 2,
  });
  await harness.establishValidatedAuth("user-next");
  await ctx.service.syncSharedDictionaryNow();

  assert.equal(ctx.cloud.requestsTo(LIST).length, 2);
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "ready");
});

test("a refusal answered after the account changed leaves the old mirror and access alone", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();

  cloud.failNext(LIST, { status: 404, code: "SHARED_DICTIONARY_NOT_MEMBER" });
  cloud.beforeServe = () => {
    harness.window.electronAPI.authGetTokenState = async () => ({
      token: "token-next",
      generation: 2,
    });
    cloud.beforeServe = null;
  };
  await service.syncSharedDictionaryNow();

  assert.equal(db.callsNamed("clearSharedDictionary").length, 0);
  assert.ok(db.workspaces.has(W1));
  assert.ok(harness.localStorage.getItem(ENTRIES_CURSOR));
  assert.equal(harness.localStorage.getItem("sharedDictionaryAccess"), null);
  assert.equal(ctx.useSharedDictionaryStore.getState().status, "ready");
});

test("a workspace without the plan is read until its mirror says paused, then left alone", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  const workspace = {
    id: W1,
    name: "Acme",
    role: "member",
    plan: "pro",
    status: "active",
    stripe_subscription_id: null,
  };
  ctx.useWorkspaceStore.setState({ loaded: true, error: false, workspaces: [workspace] });
  cloud.add(W1, ["Qdrant"]);
  cloud.workspace(W1).paused = true;

  await service.syncSharedDictionaryNow();
  assert.equal(cloud.requestsTo(LIST).length, 1);
  assert.equal(cloud.requestsTo(HIDES).length, 1);
  assert.deepEqual(ctx.hints(), { space: [], workspace: [] });

  await service.syncSharedDictionaryNow();
  assert.equal(cloud.requestsTo(LIST).length, 1, "no list request");
  assert.equal(cloud.requestsTo(HIDES).length, 1, "no hides request");
  const { snapshot, status } = ctx.useSharedDictionaryStore.getState();
  assert.equal(status, "ready");
  assert.equal(snapshot.meta.paused, true, "the page still shows the paused words");
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.word),
    ["Qdrant"]
  );
  assert.deepEqual(ctx.hints(), { space: [], workspace: [] });

  // An upgrade the workspace list knows about syncs again.
  ctx.useWorkspaceStore.setState({ workspaces: [{ ...workspace, plan: "business" }] });
  cloud.workspace(W1).paused = false;
  await service.syncSharedDictionaryNow();
  assert.equal(cloud.requestsTo(LIST).length, 2);
  assert.deepEqual(ctx.hints().workspace, ["Qdrant"]);
  assert.equal(db.callsNamed("replaceSharedDictionary").length, 1);
});

test("arrival event fires once", async (t) => {
  const ctx = await setup(t);
  const { cloud, service } = ctx;

  await service.syncSharedDictionaryNow();
  assert.equal(ctx.arrivals().length, 0, "an empty list is not an arrival");

  cloud.add(W1, ["Qdrant", "Orukeet"]);
  await service.syncSharedDictionaryNow();
  cloud.add(W1, ["Piha"]);
  await service.syncSharedDictionaryNow();

  // A sync event, not a window-local one: the pass often runs in the
  // dictation overlay, where no toast listener is mounted.
  const arrival = { accountId: "user-harness", workspaceId: W1, count: 2 };
  assert.deepEqual(ctx.arrivals(), [arrival]);
  // Recorded until a control panel shows it, which marks it welcomed.
  const welcomed = `sharedDictionaryWelcomed.user-harness.${W1}`;
  assert.equal(harness.localStorage.getItem(welcomed), null);
  assert.deepEqual(
    JSON.parse(harness.localStorage.getItem("sharedDictionaryPendingArrival")),
    arrival
  );
  assert.deepEqual(ctx.takeSharedDictionaryArrival("user-harness", W1), arrival);
  assert.equal(harness.localStorage.getItem(welcomed), "true");
  assert.equal(harness.localStorage.getItem("sharedDictionaryPendingArrival"), null);
});

test("an arrival no control panel showed yet is announced again, not lost", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.add(W1, ["Qdrant"]);
  await ctx.service.syncSharedDictionaryNow();
  assert.equal(ctx.arrivals().length, 1);

  // The mirror is rebuilt after a sign-out while the panel stayed in the tray.
  await ctx.service.purgeTeamSpacesForSignOut();
  await harness.establishValidatedAuth("user-harness");
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  await ctx.service.syncSharedDictionaryNow();

  assert.equal(ctx.arrivals().length, 2);
  assert.ok(ctx.takeSharedDictionaryArrival("user-harness", W1));
  assert.equal(ctx.takeSharedDictionaryArrival("user-harness", W1), null, "shown once");
});

test("runs when cloud backup is off", async (t) => {
  const ctx = await setup(t);
  // The team-only passes after this one have nothing faked behind them.
  const errors = t.mock.method(console, "error", () => {});
  ctx.cloud.add(W1, ["Qdrant"]);
  assert.equal(ctx.service.canSync(), false);

  await ctx.service.syncAll(true);

  assert.equal(ctx.cloud.requestsTo(LIST).length, 1);
  assert.deepEqual(ctx.hints().workspace, ["Qdrant"]);
  const sharedErrors = errors.mock.calls.filter((call) =>
    String(call.arguments[0]).startsWith("Shared dictionary")
  );
  assert.deepEqual(sharedErrors, []);
});

test("a stale pass does not publish", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  db.seed(W2, { entries: [cloud.add(W2, ["Biscuit"])[0]] });
  cloud.add(W1, ["Qdrant"]);
  const release = cloud.holdNext(LIST);

  const pass = service.syncSharedDictionaryNow();
  await flush();
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W2);
  await flush();
  assert.deepEqual(ctx.hints().workspace, ["Biscuit"]);
  release();
  await pass;

  assert.deepEqual(ctx.hints().workspace, ["Biscuit"], "W2's hints stay in place");
  assert.equal(ctx.useSharedDictionaryStore.getState().workspaceId, W2);
  assert.equal(ctx.arrivals().length, 0, "no arrival for the workspace left behind");
  assert.equal(db.workspaces.get(W1).entries.size, 1, "W1's mirror is still written");
  const persisted = JSON.parse(harness.localStorage.getItem("sharedDictionaryHints"));
  assert.equal(persisted.workspaceId, W2);
});

test("expired cursor re-snapshots and replaces", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  db.seed(W1, {
    entries: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        workspace_id: W1,
        space_id: null,
        word: "Gone",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
        deleted_at: null,
      },
    ],
  });
  harness.localStorage.setItem(ENTRIES_CURSOR, "2026-09-01T00:00:00.000Z");
  harness.localStorage.setItem(HIDES_CURSOR, "2026-09-01T00:00:00.000Z");
  cloud.add(W1, ["Qdrant", "Orukeet"]);
  cloud.failNext(LIST, { status: 410, code: "SHARED_DICTIONARY_CURSOR_EXPIRED" });

  await service.syncSharedDictionaryNow();

  const [expired, snapshot] = cloud.requestsTo(LIST).map(query);
  assert.equal(expired.since, "2026-08-31T23:59:50.000Z");
  assert.equal(snapshot.since, undefined);
  assert.equal(snapshot.cursor, undefined);
  assert.equal(db.callsNamed("replaceSharedDictionary").length, 1);
  assert.equal(db.callsNamed("replaceSharedDictionaryHides").length, 1);
  const words = (await db.api.getSharedDictionary(W1)).entries.map((entry) => entry.word);
  assert.deepEqual(words.sort(), ["Orukeet", "Qdrant"], "the entry the snapshot lacks is gone");
  assert.deepEqual(ctx.hints().workspace.sort(), ["Orukeet", "Qdrant"]);
});

test("the personal backfill resets the dictionary cursor exactly once", async (t) => {
  const ctx = await setup(t);
  harness.localStorage.setItem("lastSyncedAt.dictionary", "2026-10-01T00:00:00.000Z");
  harness.localStorage.setItem("lastSyncedAt.dictionary.id", "dict-1");

  await ctx.service.syncSharedDictionaryNow();
  assert.equal(harness.localStorage.getItem("lastSyncedAt.dictionary"), null);
  assert.equal(harness.localStorage.getItem("lastSyncedAt.dictionary.id"), null);
  assert.equal(harness.localStorage.getItem("dictionarySharedAtBackfill"), "true");

  harness.localStorage.setItem("lastSyncedAt.dictionary", "2026-10-21T00:00:00.000Z");
  await ctx.service.syncSharedDictionaryNow();
  assert.equal(harness.localStorage.getItem("lastSyncedAt.dictionary"), "2026-10-21T00:00:00.000Z");
});

test("a returning scope triggers a fresh snapshot", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();
  const passOne = cloud.requestsTo(LIST).length;

  // Space B's words predate the cursor, so a delta would never send them.
  cloud.add(W1, ["Biscuit"], {
    space_id: SPACE_B,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
  cloud.workspace(W1).scopes = [WORKSPACE_SCOPE, spaceScope(SPACE_B, "Space B")];
  cloud.setServerTime("2026-10-20T12:30:00.000Z");
  await service.syncSharedDictionaryNow();

  const [delta, snapshot] = cloud.requestsTo(LIST).slice(passOne).map(query);
  assert.ok(delta.since, "the pass starts as a delta");
  assert.equal(snapshot.since, undefined, "then re-pages from the start");
  assert.equal(snapshot.cursor, undefined);
  assert.equal(db.callsNamed("replaceSharedDictionary").length, 2);
  const hidesQueries = cloud.requestsTo(HIDES).map(query);
  assert.equal(hidesQueries.at(-1).since, undefined, "hides are re-snapshotted too");
  assert.deepEqual(ctx.hints().space, ["Biscuit"]);
  assert.equal(harness.localStorage.getItem(ENTRIES_CURSOR), "2026-10-20T12:30:00.000Z");
});

test("a list joined between snapshot pages re-runs the snapshot", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(
    W1,
    Array.from({ length: 250 }, (_, index) => `Word${index}`),
    { created_at: "2026-10-20T10:00:00.000Z", updated_at: "2026-10-20T10:00:00.000Z" }
  );
  // The member is added to Space B after page 1, whose words predate page 2's cursor.
  cloud.beforeServe = (request) => {
    if (request.pathname !== LIST || !request.query.get("cursor")) return;
    cloud.add(W1, ["Biscuit"], {
      space_id: SPACE_B,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    });
    cloud.workspace(W1).scopes = [WORKSPACE_SCOPE, spaceScope(SPACE_B, "Space B")];
    cloud.beforeServe = null;
  };

  await service.syncSharedDictionaryNow();

  const lists = cloud.requestsTo(LIST).map(query);
  assert.equal(lists.length, 4, "two pages, then two again");
  assert.equal(lists[2].cursor, undefined, "the re-run starts from the first page");
  const replaced = db.callsNamed("replaceSharedDictionary");
  assert.equal(replaced.length, 1, "only the complete snapshot is written");
  assert.equal(replaced[0].entries.length, 251);
  assert.deepEqual(ctx.hints().space, ["Biscuit"]);
  assert.equal(ctx.hints().workspace.length, 250);
});

test("a list joined during the snapshot's re-run is kept as read and snapshotted next pass", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(
    W1,
    Array.from({ length: 250 }, (_, index) => `Word${index}`),
    { created_at: "2026-10-20T10:00:00.000Z", updated_at: "2026-10-20T10:00:00.000Z" }
  );
  let joined = 0;
  cloud.beforeServe = (request) => {
    if (request.pathname !== LIST || !request.query.get("cursor")) return;
    joined += 1;
    cloud.workspace(W1).scopes = [
      ...cloud.workspace(W1).scopes,
      spaceScope(`44444444-4444-4444-8444-00000000000${joined}`),
    ];
  };

  await service.syncSharedDictionaryNow();

  assert.equal(cloud.requestsTo(LIST).length, 4, "one re-run, never a loop");
  const replaced = db.callsNamed("replaceSharedDictionary");
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].meta.scopes.length, 3, "the last page's lists");
  assert.equal(harness.localStorage.getItem(ENTRIES_CURSOR), null, "no entries cursor");

  cloud.beforeServe = null;
  await service.syncSharedDictionaryNow();
  const next = cloud.requestsTo(LIST).slice(4).map(query);
  assert.equal(next[0].since, undefined, "the next pass snapshots again");
  assert.equal(db.callsNamed("replaceSharedDictionary").length, 2);
  assert.ok(harness.localStorage.getItem(ENTRIES_CURSOR), "and stores its cursor");
});

test("no active workspace clears only the workspaces the member left", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W2);
  await flush();
  cloud.add(W2, ["Biscuit"]);
  await service.syncSharedDictionaryNow();
  const w2Cursor = `lastSyncedAt.sharedDictionary.${W2}`;
  assert.ok(harness.localStorage.getItem(w2Cursor));

  // Still a member of W1; W2 is gone from the loaded list.
  ctx.useWorkspaceStore.setState({
    loaded: true,
    error: false,
    workspaces: [{ id: W1, name: "Acme" }],
  });
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(null);
  await flush();
  await service.syncSharedDictionaryNow();

  assert.deepEqual(db.callsNamed("pruneSharedDictionary").at(-1).keepWorkspaceIds, [W1]);
  assert.equal(db.callsNamed("clearSharedDictionary").length, 0);
  assert.deepEqual([...db.workspaces.keys()], [W1], "switching back needs no re-download");
  assert.ok(harness.localStorage.getItem(ENTRIES_CURSOR));
  assert.ok(harness.localStorage.getItem(HIDES_CURSOR));
  assert.equal(harness.localStorage.getItem(w2Cursor), null);
  assert.equal(harness.localStorage.getItem(`lastSyncedAt.sharedDictionaryHides.${W2}`), null);
  assert.deepEqual(ctx.hints(), { space: [], workspace: [] });

  const listsBefore = cloud.requestsTo(LIST).length;
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  await service.syncSharedDictionaryNow();
  assert.ok(query(cloud.requestsTo(LIST)[listsBefore]).since, "W1 resumes with a delta");
});

test("no active workspace and no loaded workspace list keeps every mirror", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();

  ctx.useWorkspaceStore.setState({ loaded: false, workspaces: [] });
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(null);
  await flush();
  await service.syncSharedDictionaryNow();

  assert.equal(db.callsNamed("pruneSharedDictionary").length, 0);
  assert.equal(db.workspaces.has(W1), true);
  assert.ok(harness.localStorage.getItem(ENTRIES_CURSOR));
  assert.deepEqual(ctx.hints(), { space: [], workspace: [] });
});

test("sign-out clears the shared tables, cursors, capability and hints, not the welcome", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();
  harness.localStorage.setItem("sharedDictionaryCapability", "false");
  const generation = ctx.useSharedDictionaryStore.getState().generation;
  const welcomed = `sharedDictionaryWelcomed.user-harness.${W1}`;
  assert.ok(ctx.takeSharedDictionaryArrival("user-harness", W1), "the control panel showed it");
  assert.ok(harness.localStorage.getItem(welcomed));

  await service.purgeTeamSpacesForSignOut();

  assert.equal(db.workspaces.size, 0);
  assert.equal(db.callsNamed("clearSharedDictionary").at(-1).workspaceId, undefined);
  assert.equal(harness.localStorage.getItem(ENTRIES_CURSOR), null);
  assert.equal(harness.localStorage.getItem(HIDES_CURSOR), null);
  assert.equal(harness.localStorage.getItem(welcomed), "true", "the toast never repeats");
  assert.equal(harness.localStorage.getItem("sharedDictionaryCapability"), null);
  assert.deepEqual(ctx.hints(), { space: [], workspace: [] });
  const state = ctx.useSharedDictionaryStore.getState();
  assert.equal(state.generation, generation + 1);
  assert.equal(state.snapshot, null);
});

test("a delete behind a later snapshot page is still read by the next delta", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  const rows = cloud.add(
    W1,
    Array.from({ length: 250 }, (_, index) => `Word${index}`),
    { created_at: "2026-10-20T10:00:00.000Z", updated_at: "2026-10-20T10:00:00.000Z" }
  );
  // Between page 1 and page 2, a teammate deletes a word page 1 already sent,
  // and the server clock moves well past the read overlap.
  cloud.beforeServe = (request) => {
    if (request.pathname !== LIST || !request.query.get("cursor")) return;
    Object.assign(rows[5], {
      deleted_at: "2026-10-20T12:00:05.000Z",
      updated_at: "2026-10-20T12:00:05.000Z",
    });
    cloud.setServerTime("2026-10-20T12:00:30.000Z");
    cloud.beforeServe = null;
  };

  await service.syncSharedDictionaryNow();
  assert.equal(harness.localStorage.getItem(ENTRIES_CURSOR), "2026-10-20T12:00:00.000Z");
  const words = async () => (await db.api.getSharedDictionary(W1)).entries.map((e) => e.word);
  assert.ok((await words()).includes("Word5"), "page 1 sent it live");

  await service.syncSharedDictionaryNow();

  assert.equal(query(cloud.requestsTo(LIST).at(-1)).since, "2026-10-20T11:59:50.000Z");
  assert.equal((await words()).includes("Word5"), false);
  assert.equal((await words()).length, 249);
  assert.equal(ctx.hints().workspace.includes("Word5"), false);
});

test("an unhide behind a later hides snapshot page is still read by the next delta", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  const rows = cloud.add(
    W1,
    Array.from({ length: 250 }, (_, index) => `Word${index}`),
    { created_at: "2026-10-20T10:00:00.000Z", updated_at: "2026-10-20T10:00:00.000Z" }
  );
  for (const row of rows) cloud.hide(W1, row.id, "2026-10-20T11:00:00.000Z");
  const unhidden = cloud.workspace(W1).hides.find((hide) => hide.entry_id === rows[5].id);
  cloud.beforeServe = (request) => {
    if (request.pathname !== HIDES || !request.query.get("cursor")) return;
    Object.assign(unhidden, {
      deleted_at: "2026-10-20T12:00:05.000Z",
      updated_at: "2026-10-20T12:00:05.000Z",
    });
    cloud.setServerTime("2026-10-20T12:00:30.000Z");
    cloud.beforeServe = null;
  };

  await service.syncSharedDictionaryNow();
  assert.equal(harness.localStorage.getItem(HIDES_CURSOR), "2026-10-20T12:00:00.000Z");
  const hidden = async () => (await db.api.getSharedDictionary(W1)).hiddenIds;
  assert.ok((await hidden()).includes(rows[5].id), "page 1 sent the hide");

  await service.syncSharedDictionaryNow();

  assert.equal(query(cloud.requestsTo(HIDES).at(-1)).since, "2026-10-20T11:59:50.000Z");
  assert.equal((await hidden()).includes(rows[5].id), false);
  assert.equal((await hidden()).length, 249);
  assert.deepEqual(ctx.hints().workspace, ["Word5"]);
});

test("a delta stall throws without corrupting state", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  const [row] = cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();
  const before = await db.api.getSharedDictionary(W1);
  const cursor = harness.localStorage.getItem(ENTRIES_CURSOR);
  const errors = t.mock.method(console, "error", () => {});

  // The server keeps answering "more" with the same last row.
  const stuck = {
    entries: [row],
    hasMore: true,
    scopes: [WORKSPACE_SCOPE],
    contributors: [],
    paused: false,
    server_time: "2026-10-20T13:00:00.000Z",
  };
  cloud.respondNext(LIST, stuck);
  cloud.respondNext(LIST, stuck);
  await service.syncSharedDictionaryNow();

  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[1]), /delta stopped advancing/);
  assert.equal(cloud.requestsTo(LIST).length, 3, "it gives up instead of looping");
  assert.equal(harness.localStorage.getItem(ENTRIES_CURSOR), cursor);
  assert.deepEqual(await db.api.getSharedDictionary(W1), before);
  assert.deepEqual(ctx.hints().workspace, ["Qdrant"]);
});

test("a hides delta stall throws without moving the hides cursor", async (t) => {
  const ctx = await setup(t);
  const { cloud, service } = ctx;
  const [row] = cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();
  const cursor = harness.localStorage.getItem(HIDES_CURSOR);
  const errors = t.mock.method(console, "error", () => {});
  const hide = { entry_id: row.id, workspace_id: W1, updated_at: cursor, deleted_at: null };
  const stuck = { hides: [hide], hasMore: true, server_time: "2026-10-20T13:00:00.000Z" };
  cloud.respondNext(HIDES, stuck);
  cloud.respondNext(HIDES, stuck);

  await service.syncSharedDictionaryNow();

  assert.match(String(errors.mock.calls[0].arguments[1]), /hides delta stopped advancing/);
  assert.equal(harness.localStorage.getItem(HIDES_CURSOR), cursor);
});

test("a 410 from /hides restarts as a hides snapshot", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  const [kept, unhidden] = cloud.add(W1, ["Qdrant", "Orukeet"]);
  cloud.hide(W1, unhidden.id);
  await service.syncSharedDictionaryNow();
  assert.deepEqual((await db.api.getSharedDictionary(W1)).hiddenIds, [unhidden.id]);

  // The hide is undone and the hide of `kept` arrives, both behind an expired cursor.
  cloud.workspace(W1).hides = [];
  cloud.hide(W1, kept.id);
  cloud.failNext(HIDES, { status: 410, code: "SHARED_DICTIONARY_CURSOR_EXPIRED" });
  const hidesBefore = cloud.requestsTo(HIDES).length;
  await service.syncSharedDictionaryNow();

  const [expired, snapshot] = cloud.requestsTo(HIDES).slice(hidesBefore).map(query);
  assert.ok(expired.since);
  assert.equal(snapshot.since, undefined);
  assert.equal(snapshot.cursor, undefined);
  assert.equal(db.callsNamed("replaceSharedDictionaryHides").length, 2);
  assert.equal(db.callsNamed("replaceSharedDictionary").length, 2, "entries re-snapshot too");
  assert.deepEqual((await db.api.getSharedDictionary(W1)).hiddenIds, [kept.id]);
  assert.deepEqual(ctx.hints().workspace, ["Orukeet"]);
});

test("a failed clear after NOT_MEMBER publishes empty hints instead of reloading", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();
  const errors = t.mock.method(console, "error", () => {});
  harness.window.electronAPI.clearSharedDictionary = async () => {
    throw new Error("disk full");
  };
  cloud.failNext(LIST, { status: 404, code: "SHARED_DICTIONARY_NOT_MEMBER" });

  await service.syncSharedDictionaryNow();

  assert.equal(db.workspaces.get(W1).entries.size, 1, "the mirror could not be cleared");
  assert.deepEqual(ctx.hints(), { space: [], workspace: [] });
  assert.deepEqual(JSON.parse(harness.localStorage.getItem("sharedDictionaryHints")), {
    workspaceId: W1,
    space: [],
    workspace: [],
  });
  assert.equal(harness.localStorage.getItem(ENTRIES_CURSOR), null);
  assert.equal(errors.mock.callCount(), 1);
});

test("the arrival toast doesn't repeat after signing out and back in", async (t) => {
  const ctx = await setup(t);
  const { cloud, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();
  assert.equal(ctx.arrivals().length, 1);
  assert.ok(ctx.takeSharedDictionaryArrival("user-harness", W1));

  await service.purgeTeamSpacesForSignOut();
  await harness.establishValidatedAuth("user-harness");
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  await service.syncSharedDictionaryNow();
  assert.deepEqual(ctx.hints().workspace, ["Qdrant"], "the mirror was rebuilt");
  assert.equal(ctx.arrivals().length, 1, "same account, same workspace, same device");

  // Another account on this device gets its own.
  await service.purgeTeamSpacesForSignOut();
  await harness.establishValidatedAuth("user-other");
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  await service.syncSharedDictionaryNow();
  assert.equal(ctx.arrivals().length, 2);
});

test("a pass that changes the mirror tells other windows; a no-op pass doesn't", async (t) => {
  const ctx = await setup(t);
  const { cloud, service } = ctx;
  await service.syncSharedDictionaryNow();
  assert.deepEqual(ctx.changes(), [], "an empty list stays empty");

  const [row] = cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();
  assert.deepEqual(ctx.changes(), [{ workspaceId: W1 }]);

  await service.syncSharedDictionaryNow();
  assert.equal(ctx.changes().length, 1, "re-read rows change nothing");

  cloud.hide(W1, row.id, "2026-10-20T12:00:01.000Z");
  await service.syncSharedDictionaryNow();
  assert.equal(ctx.changes().length, 2, "a hide is a change too");
});

test("a delta pages through more than 200 rows written at the same instant", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Seed"]);
  await service.syncSharedDictionaryNow();

  // One batch: every row shares a timestamp, which the API spells without
  // milliseconds. Postgres compares the instant, not the text.
  cloud.add(
    W1,
    Array.from({ length: 250 }, (_, index) => `Batch${index}`),
    { created_at: "2026-10-20T12:05:00Z", updated_at: "2026-10-20T12:05:00Z" }
  );
  cloud.setServerTime("2026-10-20T12:10:00.000Z");
  const before = cloud.requestsTo(LIST).length;
  await service.syncSharedDictionaryNow();

  const pages = cloud.requestsTo(LIST).slice(before).map(query);
  assert.equal(pages.length, 2);
  assert.equal(pages[1].since, "2026-10-20T12:05:00Z");
  assert.ok(pages[1].since_id, "the second page resumes after the last id");
  assert.equal((await db.api.getSharedDictionary(W1)).entries.length, 251);
  assert.equal(ctx.hints().workspace.length, 251);
});

// --- windows that missed a workspace switch ---------------------------------

// What another window's setActiveWorkspaceId leaves in localStorage before this
// window's storage event arrives: the new active workspace, and the hints it
// published for it.
function otherWindowSwitchesTo(workspaceId, workspaceWords) {
  harness.localStorage.setItem("activeWorkspaceId", workspaceId);
  harness.localStorage.setItem(
    "sharedDictionaryHints",
    JSON.stringify({ workspaceId, space: [], workspace: workspaceWords })
  );
}

test("a pass in a window that missed a switch syncs the new workspace and publishes nothing", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  cloud.add(W2, ["Biscuit"]);
  await service.syncSharedDictionaryNow();
  const sentToMain = [];
  harness.window.electronAPI.setSharedDictionaryHints = async (hints) => sentToMain.push(hints);

  otherWindowSwitchesTo(W2, ["Biscuit"]);
  await service.syncSharedDictionaryNow();

  assert.equal(cloud.requestsTo(LIST).at(-1).query.get("workspace_id"), W2);
  assert.ok(db.workspaces.get(W2), "W2's mirror is written");
  assert.deepEqual(JSON.parse(harness.localStorage.getItem("sharedDictionaryHints")), {
    workspaceId: W2,
    space: [],
    workspace: ["Biscuit"],
  });
  assert.equal(ctx.arrivals().length, 1, "only W1's own arrival");
  assert.ok(sentToMain.every((hints) => !hints.workspace.includes("Qdrant")));

  // The storage event lands: this window follows, and publishes W2's words.
  const { handleActiveWorkspaceStorage } = require("../../src/stores/workspaceStore.ts");
  handleActiveWorkspaceStorage({ key: "activeWorkspaceId", newValue: W2 });
  for (let i = 0; i < 10 && ctx.hints().workspace.length === 0; i++) await flush();
  assert.equal(ctx.useWorkspaceStore.getState().activeWorkspaceId, W2);
  assert.equal(ctx.useSharedDictionaryStore.getState().workspaceId, W2);
  assert.deepEqual(ctx.hints().workspace, ["Biscuit"]);
});

test("a window launched before a workspace was picked never publishes empty hints over it", async (t) => {
  const ctx = await setup(t, { workspaceId: null });
  const { cloud, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  otherWindowSwitchesTo(W1, ["Qdrant"]);

  await service.syncSharedDictionaryNow();

  assert.equal(cloud.requestsTo(LIST).at(-1).query.get("workspace_id"), W1);
  assert.deepEqual(JSON.parse(harness.localStorage.getItem("sharedDictionaryHints")), {
    workspaceId: W1,
    space: [],
    workspace: ["Qdrant"],
  });
});

test("every pass prunes the workspaces the member left, keeping the active one", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  db.seed(W2, { entries: [cloud.add(W2, ["Biscuit"])[0]] });
  harness.localStorage.setItem(`lastSyncedAt.sharedDictionary.${W2}`, "2026-10-20T12:00:00.000Z");

  // A list loaded before the switch to W1 finished: W1 is kept all the same.
  ctx.useWorkspaceStore.setState({ loaded: true, error: false, workspaces: [] });
  await service.syncSharedDictionaryNow();

  assert.deepEqual(db.callsNamed("pruneSharedDictionary").at(-1).keepWorkspaceIds, [W1]);
  assert.deepEqual([...db.workspaces.keys()], [W1]);
  assert.equal(harness.localStorage.getItem(`lastSyncedAt.sharedDictionary.${W2}`), null);
  assert.ok(harness.localStorage.getItem(ENTRIES_CURSOR));
  assert.deepEqual(ctx.hints().workspace, ["Qdrant"]);
});

test("a stale pass records its status for its own workspace", async (t) => {
  const ctx = await setup(t);
  const { cloud, service } = ctx;
  const store = () => ctx.useSharedDictionaryStore.getState();
  cloud.add(W1, ["Qdrant"]);
  harness.localStorage.setItem("sharedDictionaryAccess", JSON.stringify({ [W2]: "ssoRequired" }));
  store().setStatus("unavailable");
  const release = cloud.holdNext(LIST);

  const pass = service.syncSharedDictionaryNow();
  await flush();
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W2);
  await flush();
  release();
  await pass;

  assert.deepEqual(JSON.parse(harness.localStorage.getItem("sharedDictionaryAccess")), {
    [W2]: "ssoRequired",
  });
  assert.equal(harness.localStorage.getItem("sharedDictionaryCapability"), "true");
  assert.equal(store().status, "ssoRequired", "W2 is still refused; the routes exist");
});

test("a delta pass replaces stored contributors with the ones its pages name", async (t) => {
  const ctx = await setup(t);
  const { cloud, db, service } = ctx;
  cloud.add(W1, ["Qdrant"]);
  await service.syncSharedDictionaryNow();
  const contributors = () => db.workspaces.get(W1).meta.contributors;
  db.workspaces.get(W1).meta.contributors = [
    { user_id: "user-teammate", name: "Tee", is_member: true },
    { user_id: "user-gone", name: "Gone", is_member: true },
  ];

  // An older API names only its pages' adders, here none: the teammate whose
  // word is still mirrored stays, the one with no words left goes.
  await service.syncSharedDictionaryNow();
  assert.deepEqual(contributors(), [{ user_id: "user-teammate", name: "Tee", is_member: true }]);

  // The current API names every adder on the first page, membership included.
  cloud.respondNext(LIST, {
    entries: [],
    hasMore: false,
    scopes: [WORKSPACE_SCOPE],
    contributors: [{ user_id: "user-teammate", name: null, is_member: false }],
    paused: false,
    server_time: "2026-10-20T12:00:00.000Z",
  });
  await service.syncSharedDictionaryNow();
  assert.deepEqual(contributors(), [{ user_id: "user-teammate", name: null, is_member: false }]);
});

// --- personal shared_at (moved words) ----------------------------------------

function personalRow(overrides = {}) {
  return {
    id: 1,
    word: "Piha",
    source: "manual",
    client_dict_id: "client-piha",
    cloud_id: null,
    sync_status: "pending",
    deleted_at: null,
    shared_at: null,
    created_at: "2026-10-01 10:00:00",
    updated_at: "2026-10-01 10:00:00",
    ...overrides,
  };
}

// `cloudEntries` answers every personal list request with one page; without
// it the fake cloud's personal list (cloud.personal) pages like the API.
async function setupPersonal(
  t,
  { pending = [], local = null, locals = null, cloudEntries = null } = {}
) {
  const ctx = await setup(t);
  harness.enableSync();
  const sent = [];
  const patched = [];
  const upserted = [];
  const hardDeleted = [];
  let broadcasts = 0;
  const sharedCloud = ctx.cloud.cloudApiRequest;
  Object.assign(harness.window.electronAPI, {
    getPendingDictionary: async () => pending,
    getPendingDictionaryDeletes: async () => [],
    getDictionaryByClientId: async (clientId) => (locals ? (locals[clientId] ?? null) : local),
    upsertDictionaryFromCloud: async (entry) => upserted.push(entry),
    markDictionarySynced: async () => ({ changes: 1 }),
    hardDeleteDictionary: async (id) => hardDeleted.push(id),
    clearDictionaryCloudId: async () => {},
    broadcastDictionaryUpdated: async () => {
      broadcasts += 1;
    },
    cloudApiRequest: async (request) => {
      if (request.path === "/api/dictionary/update") {
        patched.push(request.body);
        return { success: true, data: request.body };
      }
      if (request.path === "/api/dictionary/batch-create") {
        sent.push(...request.body.entries);
        const created = request.body.entries.map((entry, index) => ({
          ...entry,
          id: `cloud-${index}`,
        }));
        return { success: true, data: { created } };
      }
      if (cloudEntries && request.path.startsWith("/api/dictionary/list")) {
        return { success: true, data: { entries: cloudEntries, hasMore: false } };
      }
      return sharedCloud(request);
    },
  });
  return { ...ctx, sent, patched, upserted, hardDeleted, broadcasts: () => broadcasts };
}

test("a moved word resends shared_at when pushed", async (t) => {
  const ctx = await setupPersonal(t, {
    pending: [
      personalRow({ shared_at: "2026-10-20T10:00:00.000Z" }),
      personalRow({ id: 2, word: "Biscuit", client_dict_id: "client-biscuit" }),
    ],
  });

  await ctx.service.syncDictionaryNow();

  assert.deepEqual(ctx.sent[0].shared_at, "2026-10-20T10:00:00.000Z");
  // Absent keeps the server's value: the create may revive a tombstone that
  // another device had shared.
  assert.equal(Object.hasOwn(ctx.sent[1], "shared_at"), false);
});

test("a create sends an explicit null only for a local clear", async (t) => {
  const ctx = await setupPersonal(t, {
    pending: [personalRow({ shared_at_dirty: 1 })],
  });

  await ctx.service.syncDictionaryNow();

  assert.equal(Object.hasOwn(ctx.sent[0], "shared_at"), true);
  assert.equal(ctx.sent[0].shared_at, null);
});

test("an update sends shared_at only when it was set or cleared locally", async (t) => {
  const ctx = await setupPersonal(t, {
    pending: [
      // "Add back to Personal" on a moved word.
      personalRow({ cloud_id: "cloud-piha", shared_at: null, shared_at_dirty: 1 }),
      // An ordinary edit: the server may have set shared_at from another device.
      personalRow({
        id: 2,
        word: "Biscuit",
        client_dict_id: "client-biscuit",
        cloud_id: "cloud-biscuit",
        shared_at: null,
      }),
    ],
  });

  await ctx.service.syncDictionaryNow();

  assert.deepEqual(ctx.patched, [
    { id: "cloud-piha", word: "Piha", source: "manual", shared_at: null },
    { id: "cloud-biscuit", word: "Biscuit", source: "manual" },
  ]);
});

test("a pull takes the cloud's shared_at for a row at the same version", async (t) => {
  const cloudRow = {
    id: "cloud-piha",
    client_dict_id: "client-piha",
    word: "Piha",
    source: "manual",
    deleted_at: null,
    shared_at: "2026-10-20T10:00:00.000Z",
    created_at: "2026-10-01T10:00:00.000Z",
    updated_at: "2026-10-01T10:00:00.000Z",
  };
  const synced = personalRow({ cloud_id: "cloud-piha", sync_status: "synced" });

  const ctx = await setupPersonal(t, { local: synced, cloudEntries: [cloudRow] });
  await ctx.service.syncDictionaryNow();
  assert.deepEqual(
    ctx.upserted.map((entry) => entry.shared_at),
    ["2026-10-20T10:00:00.000Z"]
  );

  // A pending local edit, or an API that predates shared_at, keeps the row.
  const pendingCtx = await setupPersonal(t, {
    local: { ...synced, sync_status: "pending" },
    cloudEntries: [cloudRow],
  });
  await pendingCtx.service.syncDictionaryNow();
  assert.equal(pendingCtx.upserted.length, 0);

  const { shared_at: _omitted, ...olderApiRow } = cloudRow;
  const olderCtx = await setupPersonal(t, { local: synced, cloudEntries: [olderApiRow] });
  await olderCtx.service.syncDictionaryNow();
  assert.equal(olderCtx.upserted.length, 0);
});

function cloudPersonal(index, overrides = {}) {
  return {
    id: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, "0")}`,
    client_dict_id: `client-${index}`,
    word: `Word${index}`,
    source: "manual",
    deleted_at: null,
    shared_at: null,
    created_at: "2026-10-01T10:00:00.000Z",
    updated_at: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

test("the backfill re-reads from the epoch, so tombstones newer than the old cursor apply", async (t) => {
  // Deleted on another device after this device's last pull.
  const deletedElsewhere = cloudPersonal(1, {
    deleted_at: "2026-10-15T00:00:00.000Z",
    updated_at: "2026-10-15T00:00:00.000Z",
  });
  const local = personalRow({
    id: 7,
    word: "Word1",
    client_dict_id: "client-1",
    cloud_id: deletedElsewhere.id,
    sync_status: "synced",
  });
  const ctx = await setupPersonal(t, { locals: { "client-1": local } });
  // syncAll's other passes have nothing faked behind them.
  t.mock.method(console, "error", () => {});
  ctx.cloud.personal.push(
    deletedElsewhere,
    ...Array.from({ length: 250 }, (_, index) =>
      cloudPersonal(index + 10, { updated_at: "2026-10-20T10:00:00.000Z" })
    )
  );
  harness.localStorage.setItem("lastSyncedAt.dictionary", "2026-10-10T00:00:00.000Z");

  await ctx.service.syncAll(true);

  const lists = ctx.cloud.requestsTo("/api/dictionary/list").map(query);
  assert.equal(lists[0].since, "1970-01-01T00:00:00.000Z", "a delta, not the live snapshot");
  assert.equal(lists[1].since, "2026-10-20T10:00:00.000Z");
  assert.ok(lists[1].since_id, "the same-timestamp batch pages on its ids");
  assert.deepEqual(ctx.hardDeleted, [7], "the deletion reached this device");
  assert.equal(ctx.upserted.length, 250);
  assert.equal(harness.localStorage.getItem("lastSyncedAt.dictionary"), "2026-10-20T10:00:00.000Z");
  assert.equal(harness.localStorage.getItem("dictionarySharedAtBackfill"), "true");
});

test("an interrupted backfill starts over from the epoch", async (t) => {
  const ctx = await setupPersonal(t);
  t.mock.method(console, "error", () => {});
  ctx.cloud.personal.push(cloudPersonal(1));
  harness.localStorage.setItem("lastSyncedAt.dictionary", "2026-10-10T00:00:00.000Z");
  ctx.cloud.failNext("/api/dictionary/list", { status: 500 });

  await ctx.service.syncAll(true);
  assert.equal(harness.localStorage.getItem("lastSyncedAt.dictionary"), null);

  await ctx.service.syncDictionaryNow();
  const lists = ctx.cloud.requestsTo("/api/dictionary/list").map(query);
  assert.equal(lists.at(-1).since, "1970-01-01T00:00:00.000Z");
  assert.equal(ctx.upserted.length, 1);
});

test("an old tombstone doesn't delete a newer pending local edit", async (t) => {
  const local = personalRow({
    word: "Word1",
    client_dict_id: "client-1",
    cloud_id: "cloud-1",
    updated_at: "2026-10-20 10:00:00",
  });
  const ctx = await setupPersonal(t, { locals: { "client-1": local } });
  ctx.cloud.personal.push(
    cloudPersonal(1, {
      deleted_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    })
  );

  await ctx.service.syncDictionaryNow();

  assert.deepEqual(ctx.hardDeleted, []);
});

test("a live cloud row wins over a fallback this device retired, whatever its age", async (t) => {
  const retired = personalRow({
    word: "Word1",
    client_dict_id: "client-1",
    cloud_id: "cloud-1",
    sync_status: "synced",
    deleted_at: "2026-10-20 12:00:00",
    updated_at: "2026-10-20 12:00:00",
    fallback_retired: 1,
  });
  const deliberate = { ...retired, client_dict_id: "client-2", fallback_retired: 0 };
  const ctx = await setupPersonal(t, { locals: { "client-1": retired, "client-2": deliberate } });
  // The server kept both: the word still applies through a list never mirrored here.
  ctx.cloud.personal.push(cloudPersonal(1), cloudPersonal(2));

  await ctx.service.syncDictionaryNow();

  assert.deepEqual(
    ctx.upserted.map((entry) => entry.client_dict_id),
    ["client-1"],
    "only the guessed retirement yields; a newer user delete still wins"
  );
});

// An API whose timestamps are finer than the millisecond cursor it accepts
// repeats a batch written at one instant: the pass keeps what it applied.
test("a personal pull that stops advancing saves the applied pages and ends the pass", async (t) => {
  const ctx = await setupPersonal(t);
  const errors = t.mock.method(console, "error", () => {});
  const warnings = t.mock.method(console, "warn", () => {});
  harness.localStorage.setItem("dictionarySharedAtBackfill", "true");
  harness.localStorage.setItem("lastSyncedAt.dictionary", "2026-10-10T00:00:00.000Z");
  harness.localStorage.setItem("lastSyncedAt.dictionary.id", "dict-0");
  const row = cloudPersonal(1, { updated_at: "2026-10-12T00:00:00.000Z" });
  const stuck = { entries: [row], hasMore: true };
  ctx.cloud.respondNext("/api/dictionary/list", stuck);
  ctx.cloud.respondNext("/api/dictionary/list", stuck);

  await ctx.service.syncDictionaryNow();

  assert.equal(ctx.cloud.requestsTo("/api/dictionary/list").length, 2, "it gives up");
  assert.equal(errors.mock.callCount(), 0, "not a failure");
  assert.match(String(warnings.mock.calls[0].arguments[0]), /stopped advancing/);
  assert.equal(harness.localStorage.getItem("lastSyncedAt.dictionary"), "2026-10-12T00:00:00.000Z");
  assert.equal(harness.localStorage.getItem("lastSyncedAt.dictionary.id"), row.id);
  assert.equal(ctx.broadcasts(), 1, "the page it did apply still reaches the windows");

  // The next pass resumes there instead of re-reading everything.
  await ctx.service.syncDictionaryNow();
  const next = query(ctx.cloud.requestsTo("/api/dictionary/list").at(-1));
  assert.equal(next.since, "2026-10-12T00:00:00.000Z");
});

// Last: startAutoSync's subscription lives as long as the workspace store, so
// it would also fire in any test after this one.
test("changing the active workspace starts a shared pass for it", async (t) => {
  const ctx = await setup(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  // Keep startAutoSync's own first pass throttled; only the switch should sync.
  harness.localStorage.setItem("lastSyncedAt", new Date().toISOString());
  harness.localStorage.setItem("teamSpacesCapability.probedAt", new Date().toISOString());
  ctx.cloud.add(W2, ["Biscuit"]);
  ctx.service.startAutoSync();
  await flush();
  assert.equal(ctx.cloud.requestsTo(LIST).length, 0);

  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W2);
  for (let i = 0; i < 20 && ctx.hints().workspace.length === 0; i++) await flush();

  const lists = ctx.cloud.requestsTo(LIST);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].query.get("workspace_id"), W2);
  assert.deepEqual(ctx.hints().workspace, ["Biscuit"]);

  // Clearing the workspace is not a switch to sync.
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(null);
  await flush();
  assert.equal(ctx.cloud.requestsTo(LIST).length, 1);
});
