// A placement backfill answer naming another workspace's Private moves the
// local folders there, as a pull would. A Private→Private move carries a
// folder's subfolders on the server, so the local nesting must survive it
// whichever of the two the backfill follows first.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSyncDevice } = require("./harness/syncDevice.js");
const { createAccountCloud } = require("./harness/fakeCloud.js");

async function setup(t) {
  const device = createSyncDevice(t);
  if (!device) return null;
  const cloud = createAccountCloud({ privateWorkspacePlacement: true });
  await device.signIn("backup-owner", cloud);
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-default",
    defaultWorkspaceId: "workspace-default",
  });
  device.db.bindDefaultPrivateSpace("workspace-default");
  return { device, cloud };
}

// A synced folder of the side workspace's Private, backed up before placement.
function seedFolder(device, cloud, name, parent = null) {
  const sideSpaceId = device.db.getPrivateSpaceId("workspace-side");
  const folder = device.db.createFolder(name, sideSpaceId, parent?.local.id ?? null).folder;
  const remote = cloud.seedFolder({
    client_folder_id: folder.client_folder_id,
    name,
    private_workspace_id: null,
    parent_folder_id: parent?.remote.id ?? null,
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  device.db.markFolderSynced(folder.id, remote.id);
  device.db.db
    .prepare("UPDATE folders SET updated_at = '2026-01-01 00:00:00' WHERE id = ?")
    .run(folder.id);
  return { local: folder, remote };
}

for (const subfolderFirst of [false, true]) {
  test(`a backfill answer moving a folder to another Private keeps its subfolder nested (${subfolderFirst ? "subfolder" : "parent"} followed first)`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    const { device, cloud } = ctx;
    // Ids order the backfill's writes: the subfolder's row comes first when it is older.
    let parent;
    let child;
    if (subfolderFirst) {
      child = seedFolder(device, cloud, "Acme");
      parent = seedFolder(device, cloud, "Clients");
      device.db.db
        .prepare("UPDATE folders SET parent_folder_id = ? WHERE id = ?")
        .run(parent.local.id, child.local.id);
      await cloud.request({
        method: "PATCH",
        path: "/api/folders/update",
        body: { id: child.remote.id, parent_folder_id: parent.remote.id },
      });
    } else {
      parent = seedFolder(device, cloud, "Clients");
      child = seedFolder(device, cloud, "Acme", parent);
    }
    // Placed elsewhere between the pre-pull and the backfill: the server moves
    // the folder with its subfolder. The local rows are read as the backfill
    // leaves them, before any later pull in the pass could replay the move.
    const row = (id) => device.db.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
    let moved = false;
    let backfillWrites = 0;
    let afterBackfill = null;
    device.hooks.beforeRequest = async (request) => {
      if (request.body?.placement_backfill) {
        backfillWrites += 1;
        if (moved) return;
        moved = true;
        for (const id of [parent.remote.id, child.remote.id]) {
          await cloud.request({
            method: "PATCH",
            path: "/api/folders/update",
            body: { id, private_workspace_id: "workspace-other" },
          });
        }
      } else if (backfillWrites === 2 && !afterBackfill) {
        afterBackfill = { parent: row(parent.local.id), child: row(child.local.id) };
      }
    };

    await device.service.syncAll(true);

    assert.ok(afterBackfill, "the backfill ran");
    const otherSpaceId = device.db.getPrivateSpaceId("workspace-other");
    assert.equal(afterBackfill.parent.space_id, otherSpaceId);
    assert.equal(afterBackfill.child.space_id, otherSpaceId);
    assert.equal(afterBackfill.child.parent_folder_id, parent.local.id, "never flattened");
    assert.equal(row(parent.local.id).space_id, otherSpaceId);
    assert.equal(row(child.local.id).space_id, otherSpaceId);
    assert.equal(row(child.local.id).parent_folder_id, parent.local.id);
    assert.equal(cloud.folder(child.remote.id).parent_folder_id, parent.remote.id);
  });
}
