// A chat copy whose create ack found no local row to link is queued for a
// delete under the sender's sign-in. The queue is in localStorage, which every
// window shares, and a single chat push runs outside the sync pass, so an ack
// can queue another copy while the cleanup's deletes are out. The cleanup
// removes only the copies it deleted. Real SyncService over a real database;
// only HTTP is faked.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSyncDevice, routeOf } = require("./harness/syncDevice.js");
const { createAccountCloud } = require("./harness/fakeCloud.js");

const QUEUE_KEY = "orphanedChatCreates.account-a";

test("a copy queued while the cleanup's delete is out stays queued", async (t) => {
  const device = createSyncDevice(t);
  if (!device) return;
  const cloud = createAccountCloud();
  await device.signIn("account-a", cloud);
  localStorage.setItem(QUEUE_KEY, JSON.stringify({ "cloud-old": true }));

  let queuedDuringDelete = false;
  device.hooks.beforeRequest = async (call) => {
    if (queuedDuringDelete || routeOf(call) !== "/api/conversations/delete") return;
    queuedDuringDelete = true;
    // Another window's create ack lands now and queues its own copy.
    const queued = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "{}");
    localStorage.setItem(QUEUE_KEY, JSON.stringify({ ...queued, "cloud-new": true }));
  };
  await device.service.syncAll(true);

  assert.equal(queuedDuringDelete, true, "the cleanup's delete was in flight");
  assert.equal(
    cloud.log.some(
      (call) => routeOf(call) === "/api/conversations/delete" && call.body?.id === "cloud-old"
    ),
    true
  );
  const remaining = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "{}");
  assert.deepEqual(Object.keys(remaining), ["cloud-new"], "only the deleted copy left the queue");
});
