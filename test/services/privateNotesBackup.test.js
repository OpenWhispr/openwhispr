const test = require("node:test");
const assert = require("node:assert/strict");
const { createSyncDevice } = require("../helpers/harness/syncDevice.js");
const { createAccountCloud } = require("../helpers/harness/fakeCloud.js");
const { localStorage: storage } = require("../helpers/harness/browserGlobals.js");

async function setup(t, config = {}) {
  const device = createSyncDevice(t);
  if (!device) return null;
  const cloud = createAccountCloud(config);
  await device.signIn("backup-owner", cloud);
  return { device, cloud };
}

// The placement backfill's writes, as [route, body].
const backfillWrites = (cloud) =>
  cloud.log
    .filter((call) => call.method === "PATCH" && call.body?.placement_backfill)
    .map((call) => [call.path, call.body]);

const DEFAULT_WORKSPACE = { id: "workspace-default", name: "Default", is_default: true };
const SIDE_WORKSPACE = { id: "workspace-side", name: "Side", is_default: false };

// The workspace list this window loaded, which a sync pass reads as it finds it.
function showWorkspaceList(t, device, workspaces) {
  const { useWorkspaceStore } = require("../../src/stores/workspaceStore.ts");
  const { usePolicyStore } = require("../../src/stores/policyStore.ts");
  const priorWorkspace = useWorkspaceStore.getState();
  const priorPolicy = usePolicyStore.getState();
  t.after(() => {
    useWorkspaceStore.setState(priorWorkspace);
    usePolicyStore.setState(priorPolicy);
  });
  usePolicyStore.setState({ accountId: "backup-owner" });
  useWorkspaceStore.setState({
    loaded: true,
    error: false,
    listAccountId: "backup-owner",
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
    workspaces,
  });
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  return useWorkspaceStore;
}

test("ordinary Private notes back up with their personal folder", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud } = ctx;
  const spaceId = device.db.getDefaultPrivateSpaceId();
  const folder = device.db.createFolder("Backup folder", spaceId).folder;
  const note = device.db.saveNote(
    "My note",
    "My private content",
    "personal",
    null,
    null,
    folder.id,
    spaceId
  ).note;
  await device.service.syncAll(true);
  const saved = device.db.getNote(note.id);
  const savedFolder = device.db.getFolders().find((row) => row.id === folder.id);
  assert.ok(saved.cloud_id);
  assert.ok(savedFolder.cloud_id);
  const sent = cloud.logFor("/api/notes/batch-create").flatMap((call) => call.body.notes);
  assert.equal(
    sent.find((row) => row.client_note_id === saved.client_note_id).folder_id,
    savedFolder.cloud_id
  );
  assert.equal(cloud.logFor("/api/me/private-notes/on-device").length, 0);
});

test("a note in another workspace's Private backs up with that Private's own default folder", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const sideSpaceId = device.db.getPrivateSpaceId("workspace-side");
  const note = device.db.saveNote(
    "Side idea",
    "Side content",
    "personal",
    null,
    null,
    null,
    sideSpaceId
  ).note;
  await device.service.syncAll(true);
  const folder = device.db.getFolders(sideSpaceId).find((row) => row.id === note.folder_id);
  assert.equal(folder.name, "Personal");
  assert.ok(folder.cloud_id);
  assert.equal(cloud.folder(folder.cloud_id).private_workspace_id, "workspace-side");
  assert.equal(cloud.note(device.db.getNote(note.id).cloud_id).folder_id, folder.cloud_id);
});

test("a note pushed before its new Private folder uploads waits for it", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  await device.service.syncAll(true);
  const sideSpaceId = device.db.getPrivateSpaceId("workspace-side");
  const note = device.db.saveNote(
    "Side idea",
    "Side content",
    "personal",
    null,
    null,
    null,
    sideSpaceId
  ).note;
  // The edit's own push, before any full pass uploads the folder.
  await device.service.pushEntity("note", note.id);
  assert.equal(device.db.getNote(note.id).cloud_id, null);
  await device.service.syncAll(true);
  const folder = device.db.getFolders(sideSpaceId).find((row) => row.id === note.folder_id);
  assert.equal(cloud.note(device.db.getNote(note.id).cloud_id).folder_id, folder.cloud_id);
});

test("with Backup off a shared Private note's push doesn't wait for a folder that never uploads", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud } = ctx;
  const note = device.db.saveNote("Shared plan", "First draft").note;
  await device.service.syncAll(true);
  const cloudId = device.db.getNote(note.id).cloud_id;
  device.db.updateNoteShareState(note.id, { is_shared: 1, share_token: "token" });
  storage.setItem("cloudBackupEnabled", "false");
  const local = device.db.createFolder("Local only", device.db.getNote(note.id).space_id).folder;
  device.db.updateNote(note.id, { content: "Second draft", folder_id: local.id });
  await device.service.pushEntity("note", note.id);
  assert.equal(cloud.note(cloudId).content, "Second draft");
});

test("notes in folders restored from before placement sync, moves between them included", async (t) => {
  const ctx = await setup(t, {
    privateWorkspacePlacement: true,
    folderPlacement: true,
    defaultWorkspaceId: "workspace-default",
  });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  // Backed up by a build without placement: none of them names a workspace.
  const personal = cloud.seedFolder({
    client_folder_id: "legacy-personal",
    name: "Personal",
    is_default: true,
  });
  const meetings = cloud.seedFolder({
    client_folder_id: "legacy-meetings",
    name: "Meetings",
    is_default: true,
  });
  const projects = cloud.seedFolder({ client_folder_id: "legacy-projects", name: "Projects" });
  // At the root in the cloud; this device files it in Personal.
  const trip = cloud.seedNote({
    client_note_id: "trip",
    title: "Trip itinerary",
    content: "Day 1",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  await device.service.syncAll(true);
  const spaceId = device.db.getDefaultPrivateSpaceId();
  const localFolderId = (cloudId) =>
    device.db.getFolders(spaceId).find((folder) => folder.cloud_id === cloudId).id;
  const tripId = device.db.getNoteByClientId("trip").id;
  assert.equal(device.db.getNote(tripId).folder_id, localFolderId(personal.id));
  const note = device.db.saveNote(
    "Standup",
    "Notes",
    "meeting",
    null,
    null,
    localFolderId(meetings.id),
    spaceId
  ).note;
  device.db.updateNote(tripId, { content: "Day 1, edited" });
  await device.service.syncAll(true);
  const pushed = device.db.getNote(note.id);
  assert.equal(pushed.sync_status, "synced");
  assert.equal(cloud.note(pushed.cloud_id).folder_id, meetings.id);
  assert.equal(device.db.getNote(tripId).sync_status, "synced");
  assert.equal(cloud.note(trip.id).content, "Day 1, edited");
  assert.equal(cloud.note(trip.id).folder_id, personal.id);

  device.db.updateNote(note.id, { folder_id: localFolderId(projects.id) });
  await device.service.syncAll(true);
  assert.equal(device.db.getNote(note.id).sync_status, "synced");
  assert.equal(cloud.note(pushed.cloud_id).folder_id, projects.id);
});

test("a note the server only bumped pushes again instead of raising a conflict", async (t) => {
  const ctx = await setup(t, {
    privateWorkspacePlacement: true,
    revisionGuard: true,
    staleWriteGuard: false,
  });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const note = device.db.saveNote("Moved with its folder", "Body").note;
  await device.service.syncAll(true);
  const cloudId = device.db.getNote(note.id).cloud_id;
  // A folder given a new placement relocates its notes on the server, which bumps them.
  cloud.setNoteRevision(cloudId, 1);
  device.db.db.prepare("UPDATE notes SET sync_status = 'pending' WHERE id = ?").run(note.id);
  await device.service.syncAll(true);
  assert.equal(storage.getItem("noteConflicts.clientIds"), null);
  assert.equal(device.db.getNote(note.id).sync_status, "synced");
  assert.equal(cloud.logFor("/api/notes/update").at(-1).body.base_revision, 1);
});

test("a re-push the pass asked for still runs when another window takes the lock first", async (t) => {
  const ctx = await setup(t, {
    privateWorkspacePlacement: true,
    revisionGuard: true,
    staleWriteGuard: false,
  });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const note = device.db.saveNote("Moved with its folder", "Body").note;
  await device.service.syncAll(true);
  const cloudId = device.db.getNote(note.id).cloud_id;
  cloud.setNoteRevision(cloudId, 1);
  device.db.db.prepare("UPDATE notes SET sync_status = 'pending' WHERE id = ?").run(note.id);
  // Another window's shared dictionary sync queues for the lock while this pass runs.
  let other = null;
  device.hooks.beforeRequest = async (request) => {
    if (other || !String(request.path).startsWith("/api/snippets/list")) return;
    other = navigator.locks.request(
      "openwhispr-sync-all",
      () => new Promise((resolve) => setTimeout(resolve, 50))
    );
  };
  await device.service.syncAll(true);
  await other;
  assert.equal(device.db.getNote(note.id).sync_status, "synced");
});

test("a placement the server can't use leaves the note to retry, never forked", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  const note = device.db.saveNote("Placed", "First").note;
  await device.service.syncAll(true);
  const { cloud_id: cloudId, client_note_id: clientId } = device.db.getNote(note.id);
  device.db.updateNote(note.id, { content: "Second" });
  cloud.failNext("/api/notes/update", { status: 409, code: "private_workspace_not_found" });
  await device.service.syncAll(true);
  assert.deepEqual(
    [device.db.getNote(note.id).cloud_id, device.db.getNote(note.id).client_note_id],
    [cloudId, clientId]
  );
  await device.service.syncAll(true);
  assert.equal(device.db.getNote(note.id).sync_status, "synced");
  assert.equal(cloud.note(cloudId).content, "Second");
  assert.equal(cloud.notes().length, 1);
});

test("old device-only markers do not prevent normal retained-note recovery", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud } = ctx;
  cloud.seedNote({
    client_note_id: "retained-note",
    title: "Retained",
    content: "Cloud copy",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  storage.setItem(
    "privateNotesOnDevice:backup-owner",
    JSON.stringify({ on_device_since: "2026-01-02", purge_after: null })
  );
  storage.setItem("lastSyncedAt.notes", "2026-11-01T00:00:00.000Z");
  await device.service.syncAll(true);
  assert.equal(device.db.getNoteByClientId("retained-note")?.content, "Cloud copy");
  assert.equal(cloud.logFor("/api/me/private-notes").length, 0);
  assert.equal(cloud.logFor("/api/me/private-notes/on-device").length, 0);
});

test("Backup off leaves ordinary Private content local and does not recover personal cloud notes", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud } = ctx;
  storage.setItem("cloudBackupEnabled", "false");
  const note = device.db.saveNote("Local only", "Local content").note;
  cloud.seedNote({ client_note_id: "retained-note", content: "Cloud copy" });
  await device.service.syncAll(true);
  assert.equal(device.db.getNote(note.id).cloud_id, null);
  assert.equal(device.db.getNoteByClientId("retained-note"), null);
  assert.equal(cloud.logFor("/api/notes/batch-create").length, 0);
  assert.equal(cloud.logFor("/api/me/private-notes/on-device").length, 0);
});

test("with Backup off a shared Private note's unsent edit goes out on the next pass", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud } = ctx;
  const note = device.db.saveNote("Shared plan", "First draft").note;
  await device.service.syncAll(true);
  const cloudId = device.db.getNote(note.id).cloud_id;
  device.db.updateNoteShareState(note.id, { is_shared: 1, share_token: "token" });
  storage.setItem("cloudBackupEnabled", "false");
  // Edited while its own push couldn't reach the server.
  device.db.updateNote(note.id, { content: "Second draft" });
  await device.service.syncAll(true);
  assert.equal(cloud.note(cloudId).content, "Second draft");
  assert.equal(device.db.getNote(note.id).sync_status, "synced");
});

test("turning Backup off during the spaces request prevents personal recovery", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud } = ctx;
  cloud.seedNote({ client_note_id: "held-cloud-copy", content: "Cloud content" });
  storage.setItem("lastSyncedAt.notes", "2026-11-01T00:00:00.000Z");
  device.hooks.beforeRequest = async (request) => {
    if (request.path.startsWith("/api/me/spaces")) storage.setItem("cloudBackupEnabled", "false");
  };
  await device.service.syncAll(true);
  assert.equal(storage.getItem("syncCursors.privateBackup:backup-owner"), null);
  assert.equal(device.db.getNoteByClientId("held-cloud-copy"), null);
  assert.equal(cloud.logFor("/api/notes/batch-create").length, 0);
});

test("turning Backup off while a note list is in flight leaves its rows unapplied", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud } = ctx;
  cloud.seedNote({ client_note_id: "held-cloud-copy", content: "Cloud content" });
  device.hooks.beforeRequest = async (request) => {
    if (request.path.startsWith("/api/notes/list")) storage.setItem("cloudBackupEnabled", "false");
  };
  await device.service.syncAll(true);
  assert.equal(device.db.getNoteByClientId("held-cloud-copy"), null);
  assert.equal(storage.getItem("lastSyncedAt.notes"), null);
});

test("a new cloud note follows its known folder into that folder’s local Private workspace", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-active",
    defaultWorkspaceId: "workspace-default",
  });
  const privateId = device.db.getPrivateSpaceId();
  const folder = device.db.createFolder("Known folder", privateId).folder;
  const remoteFolder = cloud.seedFolder({
    client_folder_id: folder.client_folder_id,
    name: folder.name,
  });
  device.db.markFolderSynced(folder.id, remoteFolder.id);
  cloud.seedNote({
    client_note_id: "new-folder-note",
    content: "New cloud note",
    folder_id: remoteFolder.id,
  });
  await device.service.syncAll(true);
  const note = device.db.getNoteByClientId("new-folder-note");
  assert.equal(note.folder_id, folder.id);
  assert.equal(note.space_id, privateId);
});

test("placement-capable Backup backfills clean notes and folders without losing the original workspace", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-beta",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const spaceId = device.db.getPrivateSpaceId("workspace-beta");
  const folder = device.db.createFolder("Notes", spaceId).folder;
  const note = device.db.saveNote(
    "Existing",
    "Original",
    "personal",
    null,
    null,
    folder.id,
    spaceId
  ).note;
  const remoteFolder = cloud.seedFolder({
    client_folder_id: folder.client_folder_id,
    name: folder.name,
    private_workspace_id: null,
  });
  const remote = cloud.seedNote({
    client_note_id: note.client_note_id,
    content: "Newer cloud text",
    folder_id: remoteFolder.id,
    private_workspace_id: null,
    updated_at: "2027-01-01T00:00:00.000Z",
  });
  device.db.markFolderSynced(folder.id, remoteFolder.id);
  device.db.markNoteSynced(note.id, remote.id, "2026-01-01T00:00:00.000Z", "backup-owner");
  await device.service.syncAll(true);
  assert.equal(device.db.getNote(note.id).space_id, spaceId);
  assert.equal(device.db.getNote(note.id).content, "Newer cloud text");
  assert.equal(cloud.note(remote.id).private_workspace_id, "workspace-beta");
  assert.equal(cloud.folder(remoteFolder.id).private_workspace_id, "workspace-beta");
  assert.equal(storage.getItem("syncCursors.privatePlacement:backup-owner"), "1");
});

test("the placement backfill never files a cloud root note in the folder an older build shows it in", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const spaceId = device.db.getDefaultPrivateSpaceId();
  // An older build backed these up, and shows the cloud root note in its Personal folder.
  const note = device.db.saveNote(
    "Loose thoughts",
    "At the root",
    "personal",
    null,
    null,
    null,
    spaceId
  ).note;
  const personal = device.db.getFolders(spaceId).find((folder) => folder.id === note.folder_id);
  const remoteFolder = cloud.seedFolder({
    client_folder_id: personal.client_folder_id,
    name: personal.name,
    private_workspace_id: null,
  });
  const remote = cloud.seedNote({
    client_note_id: note.client_note_id,
    content: "At the root",
    folder_id: null,
    private_workspace_id: null,
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  device.db.markFolderSynced(personal.id, remoteFolder.id);
  device.db.markNoteSynced(note.id, remote.id, "2026-01-01T00:00:00.000Z", "backup-owner");
  await device.service.syncAll(true);
  assert.equal(cloud.note(remote.id).folder_id, null);
  // No placement already means the default's Private, so nothing is sent for it.
  assert.equal(cloud.note(remote.id).private_workspace_id, null);
  assert.deepEqual(backfillWrites(cloud), []);
  assert.equal(device.db.getNote(note.id).folder_id, personal.id);
  assert.equal(device.db.getNote(note.id).sync_status, "synced");
});

test("a row another device placed elsewhere is filed there here, never placed back", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const note = device.db.saveNote("Weekly 1:1 with Sam", "Agenda").note;
  // Moved to Side elsewhere; this device's Keep took the server's timestamp, so its copy reads
  // as current while it still sits in the default's Private.
  const remote = cloud.seedNote({
    client_note_id: note.client_note_id,
    content: "Agenda",
    private_workspace_id: "workspace-side",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  device.db.markNoteSynced(note.id, remote.id, "2026-01-01T00:00:00.000Z", "backup-owner");
  await device.service.syncAll(true);
  assert.equal(cloud.note(remote.id).private_workspace_id, "workspace-side");
  assert.deepEqual(backfillWrites(cloud), []);
  const local = device.db.getNote(note.id);
  assert.equal(device.db.getSpace(local.space_id).workspace_id, "workspace-side");
});

test("a folder in another workspace's Private gets its placement once, and its notes follow", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const sideSpaceId = device.db.getPrivateSpaceId("workspace-side");
  const folder = device.db.createFolder("Side plans", sideSpaceId).folder;
  const note = device.db.saveNote(
    "Plan",
    "Body",
    "personal",
    null,
    null,
    folder.id,
    sideSpaceId
  ).note;
  const remoteFolder = cloud.seedFolder({
    client_folder_id: folder.client_folder_id,
    name: folder.name,
    private_workspace_id: null,
  });
  const remote = cloud.seedNote({
    client_note_id: note.client_note_id,
    content: "Body",
    folder_id: remoteFolder.id,
    private_workspace_id: null,
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  device.db.markFolderSynced(folder.id, remoteFolder.id);
  device.db.markNoteSynced(note.id, remote.id, "2026-01-01T00:00:00.000Z", "backup-owner");
  await device.service.syncAll(true);
  await device.service.syncAll(true);
  assert.deepEqual(backfillWrites(cloud), [
    [
      "/api/folders/update",
      { id: remoteFolder.id, private_workspace_id: "workspace-side", placement_backfill: true },
    ],
  ]);
  assert.equal(cloud.folder(remoteFolder.id).private_workspace_id, "workspace-side");
  assert.equal(cloud.note(remote.id).private_workspace_id, "workspace-side");
});

test("a backfill answer naming another placement moves the local copy there", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const sideSpaceId = device.db.getPrivateSpaceId("workspace-side");
  const note = device.db.saveNote("Loose", "Root", "personal", null, null, null, sideSpaceId).note;
  device.db.updateNote(note.id, { folder_id: null });
  const remote = cloud.seedNote({
    client_note_id: note.client_note_id,
    content: "Root",
    private_workspace_id: null,
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  device.db.markNoteSynced(note.id, remote.id, "2026-01-01T00:00:00.000Z", "backup-owner");
  // Placed elsewhere between the pre-pull and the backfill.
  device.hooks.beforeRequest = async (request) => {
    if (!request.body?.placement_backfill) return;
    await cloud.request({
      method: "PATCH",
      path: "/api/notes/update",
      body: { id: remote.id, private_workspace_id: "workspace-other" },
    });
  };
  await device.service.syncAll(true);
  assert.equal(cloud.note(remote.id).private_workspace_id, "workspace-other");
  const local = device.db.getNote(note.id);
  assert.equal(device.db.getSpace(local.space_id).workspace_id, "workspace-other");
});

test("a backfill answer naming another placement never overwrites an unsynced edit", async (t) => {
  for (const when of ["while the write is out", "before a retried write"]) {
    await t.test(when, async (st) => {
      const ctx = await setup(st, { privateWorkspacePlacement: true });
      if (!ctx) return;
      const { device, cloud } = ctx;
      device.db.setActiveWorkspaceScope({
        activeWorkspaceId: "workspace-default",
        defaultWorkspaceId: "workspace-default",
      });
      device.db.bindDefaultPrivateSpace("workspace-default");
      const sideSpaceId = device.db.getPrivateSpaceId("workspace-side");
      const note = device.db.saveNote(
        "Loose",
        "Root",
        "personal",
        null,
        null,
        null,
        sideSpaceId
      ).note;
      device.db.updateNote(note.id, { folder_id: null });
      const remote = cloud.seedNote({
        client_note_id: note.client_note_id,
        content: "Root",
        private_workspace_id: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      device.db.markNoteSynced(note.id, remote.id, "2026-01-01T00:00:00.000Z", "backup-owner");
      // Placed elsewhere by another device, while this one's edit hasn't gone out.
      const moveAndEdit = async () => {
        await cloud.request({
          method: "PATCH",
          path: "/api/notes/update",
          body: { id: remote.id, private_workspace_id: "workspace-other" },
        });
        device.db.updateNote(note.id, { content: "An unsynced edit" });
      };
      if (when === "while the write is out") {
        device.hooks.beforeRequest = async (request) => {
          if (request.body?.placement_backfill) await moveAndEdit();
        };
      } else {
        cloud.failNext((call) => call.body?.placement_backfill, { status: 503 });
        await device.service.syncAll(true);
        await moveAndEdit();
        device.service.placementBackfillRetry.at = 0;
      }
      await device.service.syncAll(true);
      assert.ok(
        [device.db.getNote(note.id).content, cloud.note(remote.id).content].includes(
          "An unsynced edit"
        )
      );
    });
  }
});

test("a backfill write that may still succeed is retried alone, after a while", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const sideSpaceId = device.db.getPrivateSpaceId("workspace-side");
  const folders = ["One", "Two"].map((name) => {
    const folder = device.db.createFolder(name, sideSpaceId).folder;
    const remote = cloud.seedFolder({ client_folder_id: folder.client_folder_id, name });
    device.db.markFolderSynced(folder.id, remote.id);
    return remote;
  });
  cloud.failNext((call) => call.body?.placement_backfill && call.body.id === folders[1].id, {
    status: 503,
  });
  await device.service.syncAll(true);
  await device.service.syncAll(true);
  assert.equal(backfillWrites(cloud).length, 2);
  assert.deepEqual(
    JSON.parse(storage.getItem("syncCursors.privatePlacementCandidates:backup-owner")).folders,
    [
      device.db.getFolders(sideSpaceId).find((folder) => folder.cloud_id === folders[1].id)
        .client_folder_id,
    ]
  );
  device.service.placementBackfillRetry.at = 0;
  const listsBefore = cloud.logFor("/api/folders/list").length;
  await device.service.syncAll(true);
  assert.deepEqual(
    backfillWrites(cloud)
      .slice(2)
      .map(([, body]) => body.id),
    [folders[1].id]
  );
  assert.equal(cloud.folder(folders[1].id).private_workspace_id, "workspace-side");
  assert.equal(storage.getItem("syncCursors.privatePlacement:backup-owner"), "1");
  // The retry needed no snapshot pull of its own: only the pass's ordinary one.
  assert.equal(cloud.logFor("/api/folders/list").length - listsBefore, 1);
});

test("fresh personal rows restore separate Private workspaces and same-named folders", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  const privateLookup = t.mock.method(device.api, "getPrivateSpaceId");
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  for (const workspaceId of ["workspace-alpha", "workspace-beta"]) {
    const folder = cloud.seedFolder({
      client_folder_id: `folder-${workspaceId}`,
      name: "Notes",
      private_workspace_id: workspaceId,
    });
    cloud.seedNote({
      client_note_id: `note-${workspaceId}`,
      content: workspaceId,
      folder_id: folder.id,
      private_workspace_id: workspaceId,
    });
  }
  await device.service.syncAll(true);
  const alpha = device.db.getNoteByClientId("note-workspace-alpha");
  const beta = device.db.getNoteByClientId("note-workspace-beta");
  assert.notEqual(alpha.space_id, beta.space_id);
  assert.notEqual(alpha.folder_id, beta.folder_id);
  assert.equal(device.db.getSpace(alpha.space_id).workspace_id, "workspace-alpha");
  assert.equal(device.db.getSpace(beta.space_id).workspace_id, "workspace-beta");
  assert.equal(privateLookup.mock.calls.length, 2, "each unseen workspace is resolved only once");
});

test("an older API does not complete placement backfill or receive unsupported metadata", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud } = ctx;
  const note = device.db.saveNote("Old API", "Content").note;
  await device.service.syncAll(true);
  assert.equal(storage.getItem("syncCursors.privatePlacement:backup-owner"), null);
  const sent = cloud.logFor("/api/notes/batch-create").flatMap((call) => call.body.notes);
  assert.equal(
    Object.hasOwn(
      sent.find((row) => row.client_note_id === note.client_note_id),
      "private_workspace_id"
    ),
    false
  );
});

test("a later explicit default placement moves a synced note out of its prior Private workspace", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-beta",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const remote = cloud.seedNote({
    client_note_id: "moving-note",
    content: "Keep me",
    private_workspace_id: "workspace-beta",
  });
  await device.service.syncAll(true);
  assert.equal(
    device.db.getSpace(device.db.getNoteByClientId("moving-note").space_id).workspace_id,
    "workspace-beta"
  );
  await cloud.request({
    path: "/api/notes/update",
    method: "PATCH",
    body: {
      id: remote.id,
      private_workspace_id: "workspace-default",
      updated_at: "2027-01-01T00:00:00.000Z",
    },
  });
  await device.service.syncAll(true);
  assert.equal(
    device.db.getNoteByClientId("moving-note").space_id,
    device.db.getDefaultPrivateSpaceId()
  );
  assert.equal(device.db.getNoteByClientId("moving-note").content, "Keep me");
});

test("Backup off neither sends placement nor completes its backfill", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  storage.setItem("cloudBackupEnabled", "false");
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-beta",
    defaultWorkspaceId: "workspace-default",
  });
  const spaceId = device.db.getPrivateSpaceId("workspace-beta");
  const note = device.db.saveNote(
    "Keep local",
    "My text",
    "personal",
    null,
    null,
    null,
    spaceId
  ).note;
  await device.service.syncAll(true);
  assert.equal(storage.getItem("syncCursors.privatePlacement:backup-owner"), null);
  assert.equal(device.db.getNote(note.id).cloud_id, null);
  assert.equal(cloud.logFor("/api/notes/batch-create").length, 0);
});

test("an isolated first push probes placement before creating a Private note", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-beta",
    defaultWorkspaceId: "workspace-default",
  });
  const spaceId = device.db.getPrivateSpaceId("workspace-beta");
  const note = device.db.saveNote("Fast edit", "Text", "personal", null, null, null, spaceId).note;
  await device.service.ensureNoteSynced(note.id);
  const saved = device.db.getNote(note.id);
  assert.equal(cloud.note(saved.cloud_id).private_workspace_id, "workspace-beta");
});

test("a stale first-upgrade profile respects an explicit newer move to the default workspace", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-beta",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const betaId = device.db.getPrivateSpaceId("workspace-beta");
  const note = device.db.saveNote(
    "Moved elsewhere",
    "Old text",
    "personal",
    null,
    null,
    null,
    betaId
  ).note;
  const remote = cloud.seedNote({
    client_note_id: note.client_note_id,
    content: "Updated remotely",
    private_workspace_id: "workspace-default",
    updated_at: "2027-01-01T00:00:00.000Z",
  });
  device.db.markNoteSynced(note.id, remote.id, "2026-01-01T00:00:00.000Z", "backup-owner");
  await device.service.syncAll(true);
  assert.equal(device.db.getNote(note.id).space_id, device.db.getDefaultPrivateSpaceId());
  assert.equal(device.db.getNote(note.id).content, "Updated remotely");
  assert.equal(cloud.note(remote.id).private_workspace_id, "workspace-default");
});

test("a lost workspace restores into default without merging distinct cloud folders", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true, workspaces: [DEFAULT_WORKSPACE] });
  if (!ctx) return;
  const { device, cloud } = ctx;
  showWorkspaceList(t, device, [DEFAULT_WORKSPACE]);
  const original = cloud.seedFolder({
    client_folder_id: "default-notes",
    name: "Notes",
    private_workspace_id: "workspace-default",
  });
  const orphan = cloud.seedFolder({
    client_folder_id: "orphan-notes",
    name: "Notes",
    private_workspace_id: "workspace-lost",
  });
  cloud.seedNote({
    client_note_id: "orphan-note",
    content: "Owned content",
    folder_id: orphan.id,
    private_workspace_id: "workspace-lost",
  });
  await device.service.syncAll(true);
  const restored = device.db.getNoteByClientId("orphan-note");
  const folders = device.db.getFolders(device.db.getDefaultPrivateSpaceId());
  assert.equal(restored.space_id, device.db.getDefaultPrivateSpaceId());
  assert.equal(restored.content, "Owned content");
  assert.ok(folders.some((folder) => folder.cloud_id === original.id));
  const restoredFolder = folders.find((folder) => folder.cloud_id === orphan.id);
  assert.ok(restoredFolder);
  assert.notEqual(restoredFolder.name, "Notes");
  assert.equal(restored.folder_id, restoredFolder.id);
  assert.equal(cloud.folder(orphan.id).private_workspace_id, "workspace-default");
});

test("a pulled note in a workspace newer than this window's list keeps its placement", async (t) => {
  const ctx = await setup(t, {
    privateWorkspacePlacement: true,
    workspaces: [DEFAULT_WORKSPACE, SIDE_WORKSPACE],
  });
  if (!ctx) return;
  const { device, cloud } = ctx;
  // Loaded before the workspace was made on another device, which filed a note in it.
  showWorkspaceList(t, device, [DEFAULT_WORKSPACE]);
  const remote = cloud.seedNote({
    client_note_id: "side-note",
    content: "Filed in Side",
    private_workspace_id: "workspace-side",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  await device.service.syncAll(true);
  await device.service.syncAll(true);
  const local = device.db.getNoteByClientId("side-note");
  assert.equal(device.db.getSpace(local.space_id).workspace_id, "workspace-side");
  assert.equal(cloud.note(remote.id).private_workspace_id, "workspace-side");
});

test("an empty workspace list relocates no Private", async (t) => {
  const ctx = await setup(t, {
    privateWorkspacePlacement: true,
    workspaces: [DEFAULT_WORKSPACE, SIDE_WORKSPACE],
  });
  if (!ctx) return;
  const { device, cloud } = ctx;
  const useWorkspaceStore = showWorkspaceList(t, device, [DEFAULT_WORKSPACE, SIDE_WORKSPACE]);
  const remote = cloud.seedNote({
    client_note_id: "side-note",
    content: "Filed in Side",
    private_workspace_id: "workspace-side",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  await device.service.syncAll(true);
  // A faulty answer of no workspaces at all, still being given.
  useWorkspaceStore.setState({ workspaces: [] });
  cloud.config.workspaces = [];
  await device.service.syncAll(true);
  await device.service.syncAll(true);
  const local = device.db.getNoteByClientId("side-note");
  assert.equal(device.db.getSpace(local.space_id).workspace_id, "workspace-side");
  assert.equal(cloud.note(remote.id).private_workspace_id, "workspace-side");
});

test("with Backup off an owned team-to-Private transition retains its explicit workspace filing", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  const { TEAM_SPACE } = require("../helpers/harness/teamSpace.js");
  cloud.seedSpace(TEAM_SPACE, { ownerId: "backup-owner" });
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  const folder = cloud.seedFolder({
    client_folder_id: "transition-folder",
    name: "Transferred folder",
    space_id: TEAM_SPACE.id,
    workspace_id: TEAM_SPACE.workspace_id,
  });
  const note = cloud.seedNote({
    client_note_id: "transition-note",
    content: "Owned content",
    folder_id: folder.id,
    space_id: TEAM_SPACE.id,
    workspace_id: TEAM_SPACE.workspace_id,
  });
  await device.service.syncAll(true);
  storage.setItem("cloudBackupEnabled", "false");
  const scope = {
    workspace_id: null,
    space_id: null,
    private_workspace_id: "workspace-beta",
    updated_at: "2027-01-01T00:00:00.000Z",
  };
  await cloud.request({
    path: "/api/folders/update",
    method: "PATCH",
    body: { id: folder.id, ...scope },
  });
  await cloud.request({
    path: "/api/notes/update",
    method: "PATCH",
    body: { id: note.id, ...scope },
  });
  await device.service.syncAll(true);
  const moved = device.db.getNoteByClientId("transition-note");
  const movedFolder = device.db.getFolderByCloudId(folder.id);
  assert.equal(device.db.getSpace(moved.space_id).workspace_id, "workspace-beta");
  assert.equal(movedFolder.space_id, moved.space_id);
  assert.equal(moved.folder_id, movedFolder.id);
});

test("a fresh restore does not assert default placement, including after delayed default binding", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  const { TEAM_SPACE } = require("../helpers/harness/teamSpace.js");
  cloud.seedSpace(TEAM_SPACE, { ownerId: "backup-owner" });
  const folder = cloud.seedFolder({
    client_folder_id: "legacy-folder",
    name: "Legacy",
    private_workspace_id: null,
  });
  const note = cloud.seedNote({
    client_note_id: "legacy-placement",
    content: "Retained",
    folder_id: folder.id,
    private_workspace_id: null,
  });
  await device.service.syncAll(true);
  assert.equal(storage.getItem("syncCursors.privatePlacement:backup-owner"), null);
  assert.deepEqual(
    JSON.parse(storage.getItem("syncCursors.privatePlacementCandidates:backup-owner")),
    { notes: [], folders: [] }
  );
  assert.ok(device.db.getNoteByClientId("legacy-placement"));
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  await device.service.syncAll(true);
  assert.equal(storage.getItem("syncCursors.privatePlacement:backup-owner"), "1");
  assert.equal(cloud.note(note.id).private_workspace_id, null);
  assert.equal(cloud.folder(folder.id).private_workspace_id, null);
  assert.equal(device.db.getNoteByClientId("legacy-placement").content, "Retained");
});

test("forgetting an account clears only its restored-backup and placement bookkeeping", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  for (const prefix of [
    "syncCursors.privateBackup:",
    "syncCursors.privatePlacement:",
    "syncCursors.privatePlacementCandidates:",
  ]) {
    storage.setItem(`${prefix}backup-owner`, "1");
    storage.setItem(`${prefix}other-account`, "1");
  }
  ctx.device.service.forgetAccount("backup-owner");
  for (const prefix of [
    "syncCursors.privateBackup:",
    "syncCursors.privatePlacement:",
    "syncCursors.privatePlacementCandidates:",
  ]) {
    assert.equal(storage.getItem(`${prefix}backup-owner`), null);
    assert.equal(storage.getItem(`${prefix}other-account`), "1");
  }
});

test("a slower candidate read preserves the first window's original snapshot", async (t) => {
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
  device.db.bindDefaultPrivateSpace("workspace-default");
  const remote = cloud.seedNote({
    client_note_id: "restored-by-other-window",
    content: "Retained",
    private_workspace_id: null,
  });
  device.db.upsertNoteFromCloud(remote, null, device.db.getDefaultPrivateSpaceId());
  const capture = device.api.getPrivatePlacementBackupCandidates;
  device.api.getPrivatePlacementBackupCandidates = async (...args) => {
    const later = await capture(...args);
    storage.setItem(
      "syncCursors.privatePlacementCandidates:backup-owner",
      JSON.stringify({ notes: [], folders: [] })
    );
    return later;
  };
  await device.service.syncAll(true);
  assert.equal(cloud.note(remote.id).private_workspace_id, null);
  assert.equal(storage.getItem("syncCursors.privatePlacement:backup-owner"), "1");
});
