const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/lib/localMutationError.ts");

test("maps database validation messages to translation keys", async () => {
  const { localMutationErrorKey } = await load();

  assert.equal(
    localMutationErrorKey("A folder with that name already exists"),
    "notes.mutationErrors.folderAlreadyExists"
  );
  assert.equal(
    localMutationErrorKey("Cannot move default folders"),
    "notes.mutationErrors.defaultFolderImmutable"
  );
  assert.equal(
    localMutationErrorKey("Cannot purge the private space"),
    "notes.mutationErrors.privateSpaceImmutable"
  );
});

test("does not expose arbitrary main-process or cloud error text", async () => {
  const { localMutationErrorKey } = await load();

  assert.equal(
    localMutationErrorKey("connect ECONNREFUSED api.example.test"),
    "notes.mutationErrors.generic"
  );
  assert.equal(localMutationErrorKey(undefined), "notes.mutationErrors.generic");
});
