const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const queueModulePath = "../../src/helpers/cortiPrivacyCleanupQueue";

test("failed privacy cleanup is durably retried without persisting or reusing a revoked signal", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-corti-cleanup-"));
  const filePath = path.join(directory, "cleanup.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const revokedController = new AbortController();
  revokedController.abort();

  const firstQueue = require(queueModulePath).createCortiPrivacyCleanupQueue({
    filePath,
    cleanup: async () => {
      throw new Error("offline");
    },
  });
  await firstQueue.enqueue({
    environment: "us",
    tenant: "base",
    interactionId: "interaction-1",
    signal: revokedController.signal,
  });

  const persisted = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(persisted, /signal|clientSecret|clientId|token/);
  const attempts = [];
  const relaunchedQueue = require(queueModulePath).createCortiPrivacyCleanupQueue({
    filePath,
    cleanup: async (record) => attempts.push(record),
  });
  assert.deepEqual(await relaunchedQueue.retryPending(), { attempted: 1, remaining: 0 });
  assert.deepEqual(attempts, [
    {
      environment: "us",
      tenant: "base",
      interactionId: "interaction-1",
    },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).entries, []);
});
