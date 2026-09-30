// Orchestration coverage for note template and action sync: the real
// SyncService and NoteActionService over a real DatabaseManager, with only the
// HTTP boundary faked (/api/note-actions in harness/fakeCloud.js).

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  localStorage: localStorageStub,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { DETAILED_NOTES_KEY, FOLLOW_UP_EMAIL_KEY } = require("../../src/helpers/builtinActions.js");

const SECTIONS = [{ heading: "Blockers", instruction: "Anything stuck" }];

async function setup(t, { realClock = false } = {}) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  // A second per server write from now on: every change lands after the delta
  // cursor and is newer than any local row, so only a guard keeps it out.
  // realClock stamps writes the way the server does, within the same second as
  // the local edits around them.
  let now = Date.now();
  cloud.setClock(() => new Date(realClock ? Date.now() : (now += 1000)).toISOString());
  windowStub.electronAPI = createElectronApi(db, { cloud });
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, cloud, service };
}

function createTemplate(db, name = "Stand-up") {
  return db.createAction(name, "", "Keep it short", "sparkles", { sections: SECTIONS }).action;
}

// Includes tombstones, which getAction hides.
function localRow(db, clientId) {
  return db.db.prepare("SELECT * FROM actions WHERE client_id = ?").get(clientId);
}

// What another signed-in device does through the same API.
function otherDevice(cloud) {
  return {
    create: (entry) =>
      cloud.request({
        method: "POST",
        path: "/api/note-actions/batch-create",
        body: { entries: [entry] },
      }),
    delete: (id) =>
      cloud.request({ method: "DELETE", path: "/api/note-actions/delete", body: { id } }),
  };
}

function queryParam(path, name) {
  const [, query] = path.split("?");
  return new URLSearchParams(query ?? "").get(name);
}

test("custom templates and actions push whole rows; built-ins never leave the device", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const followUp = db.getActions().find((a) => a.translation_key === FOLLOW_UP_EMAIL_KEY);
  db.updateAction(followUp.id, { prompt: "My own follow-up email" });
  const template = createTemplate(db);
  const action = db.createAction("Translate", "", "Translate it to French", "globe", {
    kind: "action",
    output: "summary",
  }).action;

  await service.syncAll(true);

  const creates = cloud.logFor("/api/note-actions/batch-create");
  assert.equal(creates.length, 1);
  const entries = creates[0].body.entries;
  assert.deepEqual(
    entries.map((e) => e.client_action_id).sort(),
    [action.client_id, template.client_id].sort()
  );
  const sentTemplate = entries.find((e) => e.client_action_id === template.client_id);
  assert.equal(sentTemplate.kind, "template");
  assert.deepEqual(sentTemplate.sections, SECTIONS);
  assert.equal(sentTemplate.output, null);
  const sentAction = entries.find((e) => e.client_action_id === action.client_id);
  assert.equal(sentAction.kind, "action");
  assert.equal(sentAction.output, "summary");
  assert.equal(sentAction.sections, null);

  const cloudId = localRow(db, template.client_id).cloud_id;
  assert.ok(cloudId);
  assert.equal(localRow(db, template.client_id).sync_status, "synced");
  assert.equal(localRow(db, action.client_id).sync_status, "synced");

  // An update replaces the cloud row, so clearing the sections clears them there.
  db.updateAction(template.id, { sections: [] });
  await service.syncAll(true);

  const [patch] = cloud.logFor("/api/note-actions/update");
  assert.equal(patch.body.id, cloudId);
  assert.equal(patch.body.sections, null);
  assert.equal(cloud.noteActions().find((row) => row.id === cloudId).sections, null);
  assert.equal(localRow(db, template.client_id).sync_status, "synced");
  assert.equal(cloud.noteActions().length, 2, "no built-in reached the cloud");
});

test("a delete reaches the cloud once; a row the cloud never saw stays local", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const template = createTemplate(db);
  await service.syncAll(true);
  const cloudId = localRow(db, template.client_id).cloud_id;

  db.deleteAction(template.id);
  const draft = createTemplate(db, "Draft");
  db.deleteAction(draft.id);
  await service.syncAll(true);
  await service.syncAll(true);

  const deletes = cloud.logFor("/api/note-actions/delete");
  assert.deepEqual(
    deletes.map((call) => call.body.id),
    [cloudId]
  );
  assert.equal(localRow(db, template.client_id), undefined);
  assert.ok(cloud.noteActions().find((row) => row.id === cloudId).deleted_at);
  assert.equal(
    cloud
      .logFor("/api/note-actions/batch-create")
      .some((call) => call.body.entries.some((e) => e.client_action_id === draft.client_id)),
    false
  );
});

test("a pull applies another device's rows and tombstones and skips built-ins", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const device = otherDevice(cloud);
  const builtin = db.getActions().find((a) => a.translation_key === DETAILED_NOTES_KEY);
  await device.create({
    client_action_id: "remote-template",
    kind: "template",
    name: "1:1",
    sections: [{ heading: "Wins", instruction: "" }],
  });
  await device.create({
    client_action_id: DETAILED_NOTES_KEY,
    kind: "template",
    name: "Hijacked",
    prompt: "Say hi",
  });

  await service.syncAll(true);

  const pulled = db.getActions().find((a) => a.client_id === "remote-template");
  assert.equal(pulled.name, "1:1");
  assert.deepEqual(pulled.sections, [{ heading: "Wins", instruction: "" }]);
  assert.deepEqual(db.getAction(builtin.id), builtin);

  await device.delete(cloud.noteActions().find((r) => r.client_action_id === "remote-template").id);
  await service.syncAll(true);

  assert.equal(localRow(db, "remote-template"), undefined);
  assert.deepEqual(db.getAction(builtin.id), builtin);
});

test("the pull resumes from the (updated_at, id) cursor of the last row it saw", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, service } = ctx;
  const { data } = await otherDevice(cloud).create({
    client_action_id: "remote-action",
    kind: "action",
    name: "Tweet",
    prompt: "Write a tweet about it",
    output: "chat",
  });
  const [remote] = data.created;

  await service.syncAll(true);
  const [snapshot] = cloud.logFor("/api/note-actions/list");
  assert.equal(queryParam(snapshot.path, "since"), null, "the first pull reads the snapshot");

  await service.syncAll(true);
  const [, delta] = cloud.logFor("/api/note-actions/list");
  assert.equal(queryParam(delta.path, "since"), remote.updated_at);
  assert.equal(queryParam(delta.path, "since_id"), remote.id);
});

test("an edit to a row deleted elsewhere re-creates it instead of losing the edit", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const template = createTemplate(db);
  await service.syncAll(true);
  const cloudId = localRow(db, template.client_id).cloud_id;

  await otherDevice(cloud).delete(cloudId);
  db.updateAction(template.id, { name: "Edited offline" });
  await service.syncAll(true);

  assert.equal(localRow(db, template.client_id).cloud_id, null, "the update 404 unlinks it");
  assert.ok(db.getAction(template.id), "the remote tombstone does not delete a pending row");

  await service.syncAll(true);

  const revived = cloud.noteActions().find((row) => row.id === cloudId);
  assert.equal(revived.deleted_at, null);
  assert.equal(revived.name, "Edited offline");
  assert.equal(localRow(db, template.client_id).cloud_id, cloudId);
  assert.equal(localRow(db, template.client_id).sync_status, "synced");
});

test("an edit whose update failed survives a remote delete pulled in the same pass", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  t.mock.method(console, "error", () => {});
  const template = createTemplate(db);
  await service.syncAll(true);
  const cloudId = localRow(db, template.client_id).cloud_id;

  await otherDevice(cloud).delete(cloudId);
  db.updateAction(template.id, { name: "Edited offline" });
  cloud.failNext((call) => call.method === "PATCH", { status: 503, error: "Unavailable" });
  await service.syncAll(true);

  assert.ok(db.getAction(template.id), "the remote tombstone does not delete a pending row");

  await service.syncAll(true);
  await service.syncAll(true);

  const revived = cloud.noteActions().find((row) => row.id === cloudId);
  assert.equal(revived.deleted_at, null);
  assert.equal(revived.name, "Edited offline");
});

test("an API without note actions keeps rows pending and still completes the pass", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  t.mock.method(console, "error", () => {});
  cloud.failWith((call) => call.path.startsWith("/api/note-actions/"), {
    status: 404,
    error: "Not found",
  });
  const template = createTemplate(db);

  await service.syncAll(true);

  assert.equal(cloud.logFor("/api/note-actions/batch-create").length, 1);
  assert.equal(localRow(db, template.client_id).sync_status, "pending");
  assert.equal(localRow(db, template.client_id).cloud_id, null);
  assert.equal(localStorageStub.getItem("lastSyncedAt.noteActions"), null);
  assert.ok(localStorageStub.getItem("lastSyncedAt"), "the pass as a whole still completes");
});

// The push is answered before the pull reads the same row back, and the server's
// millisecond stamp sorts after a local edit in that second ("HH:MM:SS" reads
// as .000), so only knowing it is this pass's own write keeps the edit.
for (const [label, method, route] of [
  ["while its update is in flight", "PATCH", "/api/note-actions/update"],
  ["after the update is acknowledged", "GET", "/api/note-actions/list"],
]) {
  test(`an edit made ${label} survives the same pass's pull`, async (t) => {
    const ctx = await setup(t, { realClock: true });
    if (!ctx) return;
    const { db, cloud, service } = ctx;
    const template = createTemplate(db);
    await service.syncAll(true);
    db.updateAction(template.id, { name: "v2" });

    const request = cloud.request;
    let edited = false;
    cloud.request = async (options) => {
      if (!edited && options.method === method && options.path.startsWith(route)) {
        edited = true;
        db.updateAction(template.id, { name: "v3" });
      }
      return request(options);
    };
    await service.syncAll(true);

    const row = localRow(db, template.client_id);
    assert.equal(edited, true);
    assert.equal(row.name, "v3");
    assert.equal(row.sync_status, "pending", "the edit goes out on the next pass");

    await service.syncAll(true);
    assert.equal(
      cloud.noteActions().find((e) => e.client_action_id === template.client_id).name,
      "v3"
    );
  });
}
