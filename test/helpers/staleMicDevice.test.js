const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/staleMicDevice.js");

test("treats an OverconstrainedError on deviceId as a stale device", async () => {
  const { isStaleDeviceError } = await load();
  assert.equal(
    isStaleDeviceError({ name: "OverconstrainedError", constraint: "deviceId" }),
    true
  );
});

test("treats an OverconstrainedError with an empty constraint as a stale device", async () => {
  // Chromium sometimes reports OverconstrainedError without naming the constraint.
  const { isStaleDeviceError } = await load();
  assert.equal(isStaleDeviceError({ name: "OverconstrainedError", constraint: "" }), true);
});

test("treats an OverconstrainedError with no constraint property as a stale device", async () => {
  const { isStaleDeviceError } = await load();
  assert.equal(isStaleDeviceError({ name: "OverconstrainedError" }), true);
});

test("does not treat an OverconstrainedError on a non-deviceId constraint as stale", async () => {
  // Guards against wiping a valid mic pick when some other exact constraint fails.
  const { isStaleDeviceError } = await load();
  assert.equal(
    isStaleDeviceError({ name: "OverconstrainedError", constraint: "channelCount" }),
    false
  );
});

test("reads constraint from a getter without throwing", async () => {
  const { isStaleDeviceError } = await load();
  const error = {
    name: "OverconstrainedError",
    get constraint() {
      return "deviceId";
    },
  };
  assert.equal(isStaleDeviceError(error), true);
});

test("returns false for NotFoundError", async () => {
  const { isStaleDeviceError } = await load();
  assert.equal(isStaleDeviceError({ name: "NotFoundError" }), false);
});

test("returns false for NotAllowedError", async () => {
  const { isStaleDeviceError } = await load();
  assert.equal(isStaleDeviceError({ name: "NotAllowedError" }), false);
});

test("returns false for NotReadableError (mic in use)", async () => {
  const { isStaleDeviceError } = await load();
  assert.equal(isStaleDeviceError({ name: "NotReadableError" }), false);
});

test("returns false for a generic Error", async () => {
  const { isStaleDeviceError } = await load();
  assert.equal(isStaleDeviceError(new Error("boom")), false);
});

test("returns false for an object without a name", async () => {
  const { isStaleDeviceError } = await load();
  assert.equal(isStaleDeviceError({ constraint: "deviceId" }), false);
});

test("returns false for null", async () => {
  const { isStaleDeviceError } = await load();
  assert.equal(isStaleDeviceError(null), false);
});

test("returns false for undefined", async () => {
  const { isStaleDeviceError } = await load();
  assert.equal(isStaleDeviceError(undefined), false);
});
