// The one-time import of an account's cloud private notes: every personal
// folder and note comes into the account's default Private, then the server is
// told the account keeps its private notes on its devices (it purges the cloud
// copies 30 days later). Real DatabaseManager and SyncService on one window;
// only HTTP is faked, with one cloud per account.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSyncDevice, routeOf } = require("../helpers/harness/syncDevice.js");
const { createAccountCloud } = require("../helpers/harness/fakeCloud.js");
const { localStorage: storage } = require("../helpers/harness/browserGlobals.js");

// Mirrors BATCH_SIZE in SyncService.ts: one note more than this is two pages.
const BATCH_SIZE = 50;
const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const STATE_ROUTE = "/api/me/private-notes";
const SWITCH_ROUTE = "/api/me/private-notes/on-device";
const NOTES_LIST = "/api/notes/list";
const DAY_MS = 24 * 60 * 60 * 1000;

const markerOf = (accountId) => storage.getItem(`privateNotesOnDevice:${accountId}`);

// The server's clock runs a day behind this device's and ticks on every
// read, so a pulled_through taken from the local clock never matches the
// server_time the state call returned.
function serverClockBehind(cloud) {
  let now = Date.now() - DAY_MS;
  cloud.setClock(() => new Date((now += 1000)).toISOString());
}

// Every answer the cloud gave, beside the request it answered.
function recordAnswers(cloud) {
  const answers = [];
  const request = cloud.request;
  cloud.request = async (opts) => {
    const answer = await request(opts);
    answers.push({ route: routeOf(opts), path: opts.path, answer });
    return answer;
  };
  return answers;
}

const serverTimesOf = (answers) =>
  answers
    .filter((entry) => entry.route === STATE_ROUTE)
    .map((entry) => entry.answer.data.server_time);

// Personal notes written on other devices a while ago, oldest first.
function seedPersonalNotes(cloud, count, { prefix = "cloud-note", ...fields } = {}) {
  const start = Date.now() - 30 * DAY_MS;
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(start + index * 60_000).toISOString();
    return cloud.seedNote({
      client_note_id: `${prefix}-${index}`,
      title: `${prefix} ${index}`,
      content: `Written elsewhere ${index}`,
      created_at: at,
      updated_at: at,
      ...fields,
    });
  });
}

function liveNotes(db) {
  return db.db.prepare("SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY id").all();
}

// A device signed in as account A against an API that has the routes.
async function signedInDevice(t, cloudConfig = {}) {
  const device = createSyncDevice(t);
  if (!device) return null;
  const cloud = createAccountCloud({ privateNotesRoutes: true, ...cloudConfig });
  serverClockBehind(cloud);
  await device.signIn(ACCOUNT_A, cloud);
  return { device, cloud };
}

test("imports every personal note into the default Private and switches", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const answers = recordAnswers(cloud);
  const seeded = seedPersonalNotes(cloud, BATCH_SIZE + 1);
  // The regular passes' delta cursors: the import reads and moves neither.
  const cursor = "2026-11-01T00:00:00.000Z";
  storage.setItem("lastSyncedAt.notes", cursor);
  storage.setItem("lastSyncedAt.folders", cursor);

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  const defaultPrivate = device.db.getDefaultPrivateSpaceId();
  const imported = liveNotes(device.db);
  assert.deepEqual(
    imported.map((note) => note.client_note_id).sort(),
    seeded.map((note) => note.client_note_id).sort()
  );
  for (const note of imported) {
    assert.equal(note.space_id, defaultPrivate);
    assert.equal(note.account_id, ACCOUNT_A);
  }
  const noteLists = answers.filter((entry) => entry.route === NOTES_LIST);
  assert.equal(noteLists.length, 2, "the notes came in two pages");
  assert.ok(
    noteLists.every((entry) => !/[?&]since=/.test(entry.path)),
    "the import pulls with no cursor"
  );

  const switches = cloud.logFor(SWITCH_ROUTE);
  assert.equal(switches.length, 1);
  assert.deepEqual(switches[0].body, { pulled_through: serverTimesOf(answers)[0] });
  const state = cloud.privateNotesState();
  assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), state);
  assert.deepEqual(
    device.api.syncEvents.filter((event) => event.name === "private-notes-on-device"),
    [{ name: "private-notes-on-device", payload: { purgeAfter: state.purge_after } }]
  );
  assert.equal(storage.getItem("lastSyncedAt.notes"), cursor);
  assert.equal(storage.getItem("lastSyncedAt.folders"), cursor);
});

test("retries when the server says notes changed", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const answers = recordAnswers(cloud);
  const [edited] = seedPersonalNotes(cloud, 3);
  // Another device edits a note between this device's pull and its switch.
  let editedElsewhere = false;
  device.hooks.beforeRequest = async (call) => {
    if (editedElsewhere || routeOf(call) !== SWITCH_ROUTE) return;
    editedElsewhere = true;
    await cloud.request({
      method: "PATCH",
      path: "/api/notes/update",
      body: { id: edited.id, content: "Edited on another device" },
    });
  };

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  const switchAnswers = answers.filter((entry) => entry.route === SWITCH_ROUTE);
  assert.deepEqual(
    switchAnswers.map((entry) => entry.answer.code ?? "ok"),
    ["personal_notes_changed", "ok"]
  );
  const serverTimes = serverTimesOf(answers);
  assert.equal(serverTimes.length, 2, "a fresh server_time for the second try");
  assert.deepEqual(
    cloud.logFor(SWITCH_ROUTE).map((call) => call.body.pulled_through),
    serverTimes
  );
  assert.equal(
    answers.filter((entry) => entry.route === NOTES_LIST).length,
    2,
    "the notes were pulled again"
  );
  assert.equal(
    device.db.getNoteByClientId(edited.client_note_id).content,
    "Edited on another device"
  );
});

test("gives up after three retries while the notes keep changing", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  seedPersonalNotes(cloud, 1);
  cloud.failWith((call) => routeOf(call) === SWITCH_ROUTE, {
    status: 409,
    code: "personal_notes_changed",
  });

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");

  assert.equal(cloud.logFor(SWITCH_ROUTE).length, 4, "the first try and three retries");
  assert.equal(markerOf(ACCOUNT_A), null);
  assert.deepEqual(device.api.syncEvents, []);
});

test("a network failure mid-import switches nothing and runs again next time", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const seeded = seedPersonalNotes(cloud, BATCH_SIZE + 1);
  cloud.failNext((call) => routeOf(call) === NOTES_LIST && call.path.includes("before="), {
    status: 503,
  });
  // The pull logs the failed page.
  t.mock.method(console, "error", () => {});

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");
  assert.equal(liveNotes(device.db).length, BATCH_SIZE, "the first page arrived");
  assert.deepEqual(cloud.logFor(SWITCH_ROUTE), []);
  assert.equal(markerOf(ACCOUNT_A), null);
  assert.equal(cloud.privateNotesState(), null);

  await device.service.syncAll(true);

  assert.deepEqual(
    liveNotes(device.db)
      .map((note) => note.client_note_id)
      .sort(),
    seeded.map((note) => note.client_note_id).sort()
  );
  assert.equal(cloud.logFor(SWITCH_ROUTE).length, 1);
  assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), cloud.privateNotesState());
});

test("an account already switched skips the import", async (t) => {
  await t.test("switched on this device: nothing is asked of the cloud", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    seedPersonalNotes(cloud, 2);
    storage.setItem(
      `privateNotesOnDevice:${ACCOUNT_A}`,
      JSON.stringify({
        on_device_since: "2026-11-01T00:00:00.000Z",
        purge_after: "2026-12-01T00:00:00.000Z",
      })
    );

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "already");
    assert.deepEqual(cloud.log, []);
    assert.deepEqual(liveNotes(device.db), []);
  });

  await t.test("switched from another device: the state is kept, nothing pulled", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    seedPersonalNotes(cloud, 2);
    cloud.switchOnDevice();

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "already");
    assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), cloud.privateNotesState());
    assert.deepEqual(cloud.logFor(NOTES_LIST), []);
    assert.deepEqual(cloud.logFor(SWITCH_ROUTE), []);
    assert.deepEqual(liveNotes(device.db), []);
    assert.deepEqual(device.api.syncEvents, []);
  });

  await t.test("storage it can't read: the server is asked", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    cloud.switchOnDevice();
    const getItem = storage.getItem;
    storage.getItem = (key) => {
      if (String(key).startsWith("privateNotesOnDevice:")) throw new Error("storage unavailable");
      return getItem.call(storage, key);
    };
    st.after(() => {
      storage.getItem = getItem;
    });

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "already");
    assert.equal(cloud.logFor(STATE_ROUTE).length, 1);
    assert.deepEqual(cloud.logFor(NOTES_LIST), []);
  });
});

test("runs with Backup off", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const seeded = seedPersonalNotes(cloud, 3);
  storage.setItem("cloudBackupEnabled", "false");

  await device.service.syncAll(true);

  const defaultPrivate = device.db.getDefaultPrivateSpaceId();
  assert.deepEqual(
    liveNotes(device.db)
      .filter((note) => note.space_id === defaultPrivate)
      .map((note) => note.client_note_id)
      .sort(),
    seeded.map((note) => note.client_note_id).sort()
  );
  assert.equal(cloud.logFor(SWITCH_ROUTE).length, 1);
  assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), cloud.privateNotesState());
});

test("an account switch mid-import writes nothing more and switches nothing", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud: cloudA } = setup;
  const cloudB = createAccountCloud({ privateNotesRoutes: true });
  const seeded = seedPersonalNotes(cloudA, BATCH_SIZE + 1);
  // Snapshot pages walk created_at backwards: the oldest note is page 2.
  const pageTwo = seeded[0];
  // Page 1 is written; page 2 arrived, and the user switches to B as its first
  // row is looked up, before anything of it is written.
  const lookUp = device.api.getNoteForCloudRow;
  let rows = 0;
  device.api.getNoteForCloudRow = async (...args) => {
    rows += 1;
    if (rows === BATCH_SIZE + 1) {
      device.signOut();
      await device.signIn(ACCOUNT_B, cloudB);
    }
    return lookUp(...args);
  };

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");

  const written = device.db.db.prepare("SELECT client_note_id, account_id FROM notes").all();
  assert.equal(written.length, BATCH_SIZE, "page 1 only");
  assert.ok(written.every((row) => row.account_id === ACCOUNT_A));
  assert.ok(!written.some((row) => row.client_note_id === pageTwo.client_note_id));
  assert.deepEqual(cloudA.logFor(SWITCH_ROUTE), []);
  assert.deepEqual(cloudB.log, [], "nothing was asked of B's cloud");
  assert.equal(cloudA.privateNotesState(), null);
  assert.equal(markerOf(ACCOUNT_A), null);
  assert.equal(markerOf(ACCOUNT_B), null);
  assert.deepEqual(device.api.syncEvents, []);
});

test("a note deleted locally while its DELETE is still pending is not re-imported", async (t) => {
  await t.test("the cloud refuses the DELETE for now", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    const [deleted, kept] = seedPersonalNotes(cloud, 2);
    const local = device.db.upsertNoteFromCloud(deleted, null);
    device.db.deleteNote(local.id);
    cloud.failWith("DELETE /api/notes/delete", { status: 503 });
    // The delete push logs the refusal.
    st.mock.method(console, "error", () => {});

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

    assert.deepEqual(
      liveNotes(device.db).map((note) => note.client_note_id),
      [kept.client_note_id]
    );
    assert.ok(
      device.db.getNoteByClientId(deleted.client_note_id)?.deleted_at,
      "the tombstone stays, so its DELETE is sent again"
    );
  });

  await t.test("its DELETE goes out before the import pulls", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    const [deleted, kept] = seedPersonalNotes(cloud, 2);
    const local = device.db.upsertNoteFromCloud(deleted, null);
    device.db.deleteNote(local.id);

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

    assert.ok(cloud.note(deleted.id).deleted_at, "the delete reached the cloud");
    assert.deepEqual(
      liveNotes(device.db).map((note) => note.client_note_id),
      [kept.client_note_id]
    );
    assert.equal(device.db.getNoteByClientId(deleted.client_note_id), null);
    assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), cloud.privateNotesState());
  });
});

test("a note already on this device keeps its space and folder", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  // A Cloud Backup copy filed in another workspace's Private, in a folder there.
  const otherPrivate = device.db.getPrivateSpaceId("workspace-other");
  const { folder } = device.db.createFolder("Projects", otherPrivate);
  const [note] = seedPersonalNotes(cloud, 1);
  device.db.upsertNoteFromCloud(
    {
      ...note,
      content: "Backed up earlier",
      updated_at: new Date(Date.parse(note.updated_at) - DAY_MS).toISOString(),
    },
    folder.id,
    otherPrivate
  );
  assert.notEqual(otherPrivate, device.db.getDefaultPrivateSpaceId());

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  const local = device.db.getNoteByClientId(note.client_note_id);
  assert.equal(local.content, note.content, "the newer cloud copy applied");
  assert.equal(local.space_id, otherPrivate);
  assert.equal(local.folder_id, folder.id);
  assert.equal(liveNotes(device.db).length, 1);
});

test("the cloud's Personal and Meetings folders merge into the default Private's own", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const defaultPrivate = device.db.getDefaultPrivateSpaceId();
  device.db.ensureDefaultFolders(defaultPrivate);
  const localFolders = Object.fromEntries(
    device.db.getFolders(defaultPrivate).map((folder) => [folder.name, folder.id])
  );
  assert.deepEqual(Object.keys(localFolders).sort(), ["Meetings", "Personal"]);
  const cloudPersonal = cloud.seedFolder({
    name: "Personal",
    is_default: true,
    sort_order: 0,
    client_folder_id: "cloud-personal",
  });
  const cloudMeetings = cloud.seedFolder({
    name: "Meetings",
    is_default: true,
    sort_order: 1,
    client_folder_id: "cloud-meetings",
  });
  const [inPersonal] = seedPersonalNotes(cloud, 1, {
    prefix: "personal-note",
    folder_id: cloudPersonal.id,
  });
  const [inMeetings] = seedPersonalNotes(cloud, 1, {
    prefix: "meeting-note",
    folder_id: cloudMeetings.id,
  });

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  const folders = device.db.getFolders(defaultPrivate);
  assert.deepEqual(
    folders.map((folder) => [folder.id, folder.name, folder.cloud_id]).sort(),
    [
      [localFolders.Meetings, "Meetings", cloudMeetings.id],
      [localFolders.Personal, "Personal", cloudPersonal.id],
    ].sort(),
    "no duplicate folders: each local default adopted its cloud folder"
  );
  assert.equal(
    device.db.getNoteByClientId(inPersonal.client_note_id).folder_id,
    localFolders.Personal
  );
  assert.equal(
    device.db.getNoteByClientId(inMeetings.client_note_id).folder_id,
    localFolders.Meetings
  );
});

test("a second call while an import runs joins it", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  seedPersonalNotes(cloud, 1);

  const first = device.service.importCloudPrivateNotes(ACCOUNT_A);
  const second = device.service.importCloudPrivateNotes(ACCOUNT_A);

  assert.deepEqual(await Promise.all([first, second]), ["switched", "switched"]);
  assert.equal(cloud.logFor(STATE_ROUTE).length, 1);
  assert.equal(cloud.logFor(SWITCH_ROUTE).length, 1);
});

test("an API without the routes fails quietly", async (t) => {
  const setup = await signedInDevice(t, { privateNotesRoutes: false });
  if (!setup) return;
  const { device, cloud } = setup;
  seedPersonalNotes(cloud, 1);
  const errors = t.mock.method(console, "error", () => {});

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");

  assert.deepEqual(cloud.logFor(NOTES_LIST), []);
  assert.deepEqual(liveNotes(device.db), []);
  assert.equal(markerOf(ACCOUNT_A), null);
  assert.deepEqual(device.api.syncEvents, []);
  assert.equal(errors.mock.callCount(), 0);
});
