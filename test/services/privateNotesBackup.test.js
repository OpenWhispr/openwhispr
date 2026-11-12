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
  const ctx = await setup(t, { privateWorkspacePlacement: true });
  if (!ctx) return;
  const { device, cloud } = ctx;
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
    workspaces: [{ id: "workspace-default", name: "Default" }],
  });
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
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
