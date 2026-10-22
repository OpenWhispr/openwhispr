// The shared dictionary store follows workspaceStore's active workspace: every
// change empties the hints at once, then publishes the new workspace's words
// from the local mirror. Loads started under an older generation never publish.

const test = require("node:test");
const assert = require("node:assert/strict");

const harness = require("../helpers/harness/browserGlobals.js");
const {
  cloudEntry,
  createSharedDictionaryDb,
} = require("../helpers/harness/sharedDictionaryFakes.js");

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const W3 = "44444444-4444-4444-8444-444444444444";
const EMPTY = { space: [], workspace: [] };

const flush = () => new Promise((resolve) => setImmediate(resolve));

function workspace(id) {
  return { id, name: id, slug: id, my_role: "member" };
}

async function setup(t, { workspaces = [] } = {}) {
  harness.resetBrowserGlobals();
  harness.installBrowserGlobals();
  const db = createSharedDictionaryDb();
  db.seed(W1, { entries: [cloudEntry(W1, "Qdrant")] });
  db.seed(W2, { entries: [cloudEntry(W2, "Biscuit")] });
  const sentToMain = [];
  harness.window.electronAPI = {
    ...db.api,
    setSharedDictionaryHints: async (hints) => {
      sentToMain.push(hints);
    },
    cloudApiRequest: async ({ path }) =>
      path === "/api/workspaces"
        ? { success: true, data: { data: workspaces } }
        : { success: false, status: 404 },
  };

  const { useWorkspaceStore } = require("../../src/stores/workspaceStore.ts");
  const { useSharedDictionaryStore } = require("../../src/stores/sharedDictionaryStore.ts");
  const { useSettingsStore } = require("../../src/stores/settingsStore.ts");
  useWorkspaceStore.getState().resetForAccountChange();
  await flush();
  sentToMain.length = 0;

  const hints = () => useSettingsStore.getState().sharedDictionaryHints;
  const persisted = () => JSON.parse(harness.localStorage.getItem("sharedDictionaryHints"));
  return {
    db,
    sentToMain,
    hints,
    persisted,
    useWorkspaceStore,
    useSharedDictionaryStore,
    setWorkspaces(next) {
      workspaces = next;
    },
  };
}

test("switching active workspace reloads hints", async (t) => {
  const ctx = await setup(t);
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  assert.deepEqual(ctx.hints(), { space: [], workspace: ["Qdrant"] });
  const generation = ctx.useSharedDictionaryStore.getState().generation;

  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W2);

  // Emptied synchronously, for this window, the other windows and main.
  assert.deepEqual(ctx.hints(), EMPTY);
  assert.deepEqual(ctx.persisted(), { workspaceId: W2, ...EMPTY });
  assert.deepEqual(ctx.sentToMain.at(-1), EMPTY);
  const state = ctx.useSharedDictionaryStore.getState();
  assert.equal(state.workspaceId, W2);
  assert.equal(state.generation, generation + 1);
  assert.equal(state.snapshot, null);

  await flush();
  assert.deepEqual(ctx.hints(), { space: [], workspace: ["Biscuit"] });
  assert.deepEqual(ctx.persisted(), { workspaceId: W2, space: [], workspace: ["Biscuit"] });
  assert.deepEqual(ctx.sentToMain.at(-1), { space: [], workspace: ["Biscuit"] });
  assert.deepEqual(
    ctx.useSharedDictionaryStore.getState().snapshot.entries.map((entry) => entry.word),
    ["Biscuit"]
  );
});

test("refresh() auto-selecting the only workspace loads its hints", async (t) => {
  const ctx = await setup(t, { workspaces: [workspace(W1)] });
  assert.equal(ctx.useWorkspaceStore.getState().activeWorkspaceId, null);

  await ctx.useWorkspaceStore.getState().refresh();
  await flush();

  assert.equal(ctx.useSharedDictionaryStore.getState().workspaceId, W1);
  assert.deepEqual(ctx.hints(), { space: [], workspace: ["Qdrant"] });
});

test("refresh() dropping the active workspace empties hints", async (t) => {
  const ctx = await setup(t, { workspaces: [workspace(W1)] });
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  assert.deepEqual(ctx.hints().workspace, ["Qdrant"]);

  // The member left W1 and belongs to two others: nothing is auto-selected.
  ctx.setWorkspaces([workspace(W2), workspace(W3)]);
  await ctx.useWorkspaceStore.getState().refresh();
  await flush();

  assert.equal(ctx.useWorkspaceStore.getState().activeWorkspaceId, null);
  assert.equal(ctx.useSharedDictionaryStore.getState().workspaceId, null);
  assert.deepEqual(ctx.hints(), EMPTY);
  assert.deepEqual(ctx.persisted(), { workspaceId: null, ...EMPTY });
});

test("a load from an older generation never publishes", async (t) => {
  const ctx = await setup(t);
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  const { generation } = ctx.useSharedDictionaryStore.getState();
  ctx.db.seed(W1, { entries: [cloudEntry(W1, "Orukeet")] });

  await ctx.useSharedDictionaryStore.getState().load(W1, generation - 1);
  assert.deepEqual(ctx.hints().workspace, ["Qdrant"]);
  await ctx.useSharedDictionaryStore.getState().load(W2, generation);
  assert.deepEqual(ctx.hints().workspace, ["Qdrant"], "nor one for another workspace");

  await ctx.useSharedDictionaryStore.getState().reload();
  assert.deepEqual(ctx.hints().workspace, ["Qdrant", "Orukeet"]);
});

test("an account change empties the hints", async (t) => {
  const ctx = await setup(t);
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  ctx.useSharedDictionaryStore.getState().setRequestedList("workspace");

  ctx.useWorkspaceStore.getState().resetForAccountChange();

  assert.deepEqual(ctx.hints(), EMPTY);
  const state = ctx.useSharedDictionaryStore.getState();
  assert.equal(state.workspaceId, null);
  assert.equal(state.requestedList, null);
});

test("an access status is kept per workspace and cleared by success or account change", async (t) => {
  const ctx = await setup(t);
  const store = () => ctx.useSharedDictionaryStore.getState();
  const stored = () => JSON.parse(harness.localStorage.getItem("sharedDictionaryAccess"));
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();

  store().setStatus("noAccess");
  assert.deepEqual(stored(), { [W1]: "noAccess" });
  assert.equal(harness.localStorage.getItem("sharedDictionaryCapability"), "true");

  // B's own status doesn't clear A's.
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W2);
  await flush();
  assert.equal(store().status, "ready", "another workspace isn't refused");
  store().setStatus("ssoRequired");
  store().setStatus("ready");
  assert.deepEqual(stored(), { [W1]: "noAccess" });
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  assert.equal(store().status, "noAccess");

  store().setStatus("ready");
  assert.equal(stored(), null);

  store().setStatus("ssoRequired");
  store().resetForAccountChange();
  assert.equal(store().status, "ready");
  assert.equal(stored(), null);

  // An API without the routes stays unavailable across workspaces.
  store().setStatus("unavailable");
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W2);
  await flush();
  assert.equal(store().status, "unavailable");
  store().setStatus("ready");
});

test("a status another window writes reaches this window's workspace only", async (t) => {
  const ctx = await setup(t);
  const {
    handleSharedDictionaryStatusStorage,
  } = require("../../src/stores/sharedDictionaryStore.ts");
  const store = () => ctx.useSharedDictionaryStore.getState();
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  const otherWindowWrites = (map) => {
    const value = map ? JSON.stringify(map) : null;
    if (value) harness.localStorage.setItem("sharedDictionaryAccess", value);
    else harness.localStorage.removeItem("sharedDictionaryAccess");
    handleSharedDictionaryStatusStorage({ key: "sharedDictionaryAccess", newValue: value });
  };

  otherWindowWrites({ [W2]: "noAccess" });
  assert.equal(store().status, "ready", "W2's refusal isn't this window's");

  otherWindowWrites({ [W1]: "ssoRequired", [W2]: "noAccess" });
  assert.equal(store().status, "ssoRequired");

  otherWindowWrites({ [W2]: "noAccess" });
  assert.equal(store().status, "ready", "its next good pass clears it here too");

  handleSharedDictionaryStatusStorage({ key: "unrelated", newValue: "x" });
  assert.equal(store().status, "ready");
  otherWindowWrites(null);
});

test("a workspace switch in another window moves this window's stores with it", async (t) => {
  const ctx = await setup(t);
  const { handleActiveWorkspaceStorage } = require("../../src/stores/workspaceStore.ts");
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  await flush();
  ctx.useWorkspaceStore.setState({ members: [{ user_id: "user-w1" }] });

  // Another window wrote the key and published W2's hints first.
  harness.localStorage.setItem("activeWorkspaceId", W2);
  handleActiveWorkspaceStorage({ key: "activeWorkspaceId", newValue: W2 });

  assert.equal(ctx.useWorkspaceStore.getState().activeWorkspaceId, W2);
  assert.deepEqual(ctx.useWorkspaceStore.getState().members, [], "W1's roster is dropped");
  assert.equal(ctx.useSharedDictionaryStore.getState().workspaceId, W2);
  await flush();
  assert.deepEqual(ctx.hints(), { space: [], workspace: ["Biscuit"] });

  handleActiveWorkspaceStorage({ key: "unrelated", newValue: W1 });
  assert.equal(ctx.useWorkspaceStore.getState().activeWorkspaceId, W2);

  harness.localStorage.removeItem("activeWorkspaceId");
  handleActiveWorkspaceStorage({ key: "activeWorkspaceId", newValue: null });
  assert.equal(ctx.useSharedDictionaryStore.getState().workspaceId, null);
  assert.deepEqual(ctx.hints(), EMPTY);
});

test("hints for a workspace localStorage no longer names are never published", async (t) => {
  const ctx = await setup(t);
  const { useSettingsStore } = require("../../src/stores/settingsStore.ts");
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W2);
  await flush();
  const sent = ctx.sentToMain.length;

  // A window whose store still says W1 (its storage event hasn't landed).
  useSettingsStore.getState().setSharedDictionaryHints({ space: [], workspace: ["Qdrant"] }, W1);
  useSettingsStore.getState().setSharedDictionaryHints(EMPTY, null);

  assert.deepEqual(ctx.persisted(), { workspaceId: W2, space: [], workspace: ["Biscuit"] });
  assert.deepEqual(ctx.hints(), { space: [], workspace: ["Biscuit"] }, "it takes W2's instead");
  assert.equal(ctx.sentToMain.length, sent, "main keeps W2's");
});

test("a status for another workspace is recorded there, not on this one", async (t) => {
  const ctx = await setup(t);
  const store = () => ctx.useSharedDictionaryStore.getState();
  const stored = () => JSON.parse(harness.localStorage.getItem("sharedDictionaryAccess"));
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W2);
  await flush();
  store().setStatus("ssoRequired");

  store().setStatus("noAccess", W1);
  assert.deepEqual(stored(), { [W1]: "noAccess", [W2]: "ssoRequired" });
  assert.equal(store().status, "ssoRequired");

  store().setStatus("ready", W1);
  assert.deepEqual(stored(), { [W2]: "ssoRequired" }, "W2's refusal stays");
  assert.equal(store().status, "ssoRequired");
  store().resetForAccountChange();
});

test("a pending arrival is taken once, by its own account and workspace", async (t) => {
  await setup(t);
  const {
    recordSharedDictionaryArrival,
    takeSharedDictionaryArrival,
  } = require("../../src/stores/sharedDictionaryStore.ts");
  const arrival = { accountId: "user-a", workspaceId: W1, count: 3 };
  const pending = () => harness.localStorage.getItem("sharedDictionaryPendingArrival");

  recordSharedDictionaryArrival(arrival);
  assert.equal(takeSharedDictionaryArrival(null, W1), null, "waits for the account");
  assert.ok(pending());
  assert.deepEqual(takeSharedDictionaryArrival("user-a", W1), arrival);
  assert.equal(takeSharedDictionaryArrival("user-a", W1), null);
  assert.equal(harness.localStorage.getItem(`sharedDictionaryWelcomed.user-a.${W1}`), "true");

  recordSharedDictionaryArrival(arrival);
  assert.equal(pending(), null, "a welcomed workspace records nothing");

  recordSharedDictionaryArrival({ ...arrival, workspaceId: W2 });
  assert.equal(takeSharedDictionaryArrival("user-b", W2), null, "another account's");
  assert.equal(pending(), null, "is dropped");
  recordSharedDictionaryArrival({ ...arrival, workspaceId: W2 });
  assert.equal(takeSharedDictionaryArrival("user-a", W3), null, "another workspace's too");
  assert.equal(pending(), null);
  assert.equal(harness.localStorage.getItem(`sharedDictionaryWelcomed.user-a.${W2}`), null);

  harness.localStorage.setItem("sharedDictionaryPendingArrival", "{not json");
  assert.equal(takeSharedDictionaryArrival("user-a", W1), null);
  assert.equal(pending(), null);
});

test("the page's Sync stamps lastSyncedAt, even without a workspace, until the scope changes", async (t) => {
  const ctx = await setup(t);
  const store = () => ctx.useSharedDictionaryStore.getState();
  assert.equal(store().workspaceId, null);
  assert.equal(store().lastSyncedAt, null);

  const before = Date.now();
  store().markSynced(store().generation);
  const stamped = store().lastSyncedAt;
  assert.ok(Date.parse(stamped) >= before);
  // The page rereads the mirror whenever it opens; that keeps the stamp.
  await store().reload();
  assert.equal(store().lastSyncedAt, stamped);

  // A Sync that finishes after a workspace switch says nothing about the new one.
  const started = store().generation;
  ctx.useWorkspaceStore.getState().setActiveWorkspaceId(W1);
  assert.equal(store().lastSyncedAt, null);
  store().markSynced(started);
  assert.equal(store().lastSyncedAt, null);
  await flush();
  assert.ok(store().lastSyncedAt, "the shared pass's own time");

  // An older pass time read later never rolls a newer Sync back.
  store().markSynced(store().generation);
  const newer = store().lastSyncedAt;
  const read = harness.window.electronAPI.getSharedDictionary;
  harness.window.electronAPI.getSharedDictionary = async (id) => {
    const snapshot = await read(id);
    return { ...snapshot, meta: { ...snapshot.meta, syncedAt: "2020-01-01T00:00:00.000Z" } };
  };
  await store().reload();
  assert.equal(store().lastSyncedAt, newer);
});
