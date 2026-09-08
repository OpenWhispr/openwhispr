const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ipcHandlersSource = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/ipcHandlers.js"),
  "utf8"
);

function handlerBody(channel, nextChannel) {
  const match = ipcHandlersSource.match(
    new RegExp(`ipcMain\\.handle\\("${channel}"([\\s\\S]*?)ipcMain\\.handle\\("${nextChannel}"`)
  );
  assert.ok(match, `${channel} handler is present`);
  return match[1];
}

// Folder deletion releases other accounts' notes to the space root instead of
// deleting them. Their markdown mirror files live under the folder's mirror
// directory, which is removed with the folder — so the handlers must rewrite
// every live relocated note at its new location.
test("folder delete handlers rewrite relocated notes into the markdown mirror", () => {
  for (const [channel, nextChannel] of [
    ["db-delete-folder", "db-rename-folder"],
    ["db-hard-delete-folder", "db-relocate-revoked-folder"],
  ]) {
    const source = handlerBody(channel, nextChannel);
    assert.ok(source.includes("relocatedNotes"), `${channel} consumes relocatedNotes`);
    assert.ok(source.includes("_asyncMirrorWrite"), `${channel} rewrites relocated mirror files`);
  }
});
