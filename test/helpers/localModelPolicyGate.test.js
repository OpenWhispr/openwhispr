const test = require("node:test");
const assert = require("node:assert/strict");
const { managedPolicy } = require("./harness/policyFixtures");

const state = (ids = ["base"], revision = 1, authGeneration = 1) => ({
  success: true,
  managed: true,
  authGeneration,
  revision,
  policy: managedPolicy({ transcription: { allowedModes: ["local"], allowedLocalModels: ids } }),
});

test("unknown catalog IDs keep ordinary validation errors for managed and unmanaged callers", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  for (const snapshot of [state([]), { success: true, managed: false }]) {
    const gate = createLocalModelPolicyGate({
      getPolicy: async () => snapshot,
      getIdentity: () => 1,
      getAppVersion: () => "1.11.1",
    });
    await assert.rejects(gate.authorize("transcription", "not-a-real-model"), (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /[Uu]nknown.*model/);
      return true;
    });
    for (const blankId of ["", "   ", "\t\n"]) {
      await assert.rejects(gate.authorize("transcription", blankId), {
        code: "POLICY_MODEL_BLOCKED",
      });
    }
    await assert.rejects(gate.authorize("transcription", " base "), (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /[Uu]nknown.*model/);
      return true;
    });
  }
});

test("main rejects unresolved identity and memory-only lookups; known guest and approved work run", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let next = { success: false };
  let calls = 0;
  const gate = createLocalModelPolicyGate({
    getPolicy: async () => {
      calls++;
      return next;
    },
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
  });
  await assert.rejects(gate.authorize("transcription", "base", { memoryOnly: true }), {
    code: "POLICY_UNRESOLVABLE",
  });
  assert.equal(calls, 0);
  await assert.rejects(gate.authorize("transcription", "base"), { code: "POLICY_UNRESOLVABLE" });
  next = { success: true, managed: false, authGeneration: 1 };
  const guest = await gate.authorize("transcription", "base");
  gate.release(guest);
  next = state();
  const allowed = await gate.authorize("transcription", "base");
  assert.doesNotThrow(() => gate.assertCurrent(allowed));
  await assert.rejects(gate.authorize("transcription", "small"), { code: "POLICY_MODEL_BLOCKED" });
  next.policy.transcription.allowedModes = [];
  next.revision++;
  await assert.rejects(gate.authorize("transcription", "base"), {
    code: "POLICY_LOCAL_MODE_BLOCKED",
  });
});

test("policy changes revoke leases, suppress late responses and ignore old revisions/generations", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let identity = 1;
  let next = state();
  const gate = createLocalModelPolicyGate({
    getPolicy: async () => next,
    getIdentity: () => identity,
    getAppVersion: () => "1.11.1",
  });
  const lease = await gate.authorize("transcription", "base");
  gate.update(state([], 2));
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => gate.assertCurrent(lease), { code: "POLICY_MODEL_BLOCKED" });
  gate.update(state(["base"], 1));
  gate.update(state(["base"], 3, 0));
  await assert.rejects(gate.authorize("transcription", "base", { memoryOnly: true }), {
    code: "POLICY_MODEL_BLOCKED",
  });
  gate.release(lease);
  next = state(["base"], 3);
  const restored = await gate.authorize("transcription", "base");
  identity++;
  gate.invalidate();
  assert.throws(() => gate.assertCurrent(restored), { code: "POLICY_UNRESOLVABLE" });
  await assert.rejects(gate.authorize("transcription", "base"), { code: "POLICY_UNRESOLVABLE" });
});

test("delayed policy from a previous identity never authorizes a new action", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let resolve;
  let identity = 1;
  const gate = createLocalModelPolicyGate({
    getPolicy: () =>
      new Promise((done) => {
        resolve = done;
      }),
    getIdentity: () => identity,
    getAppVersion: () => "1.11.1",
  });
  const pending = gate.authorize("transcription", "base");
  await new Promise((done) => setImmediate(done));
  identity++;
  gate.invalidate();
  resolve(state());
  await assert.rejects(pending, { code: "POLICY_UNRESOLVABLE" });
});

test("app version failure and effective empty approvals stay distinct", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  const next = state();
  next.policy.minAppVersion = "1.11.1";
  const gate = createLocalModelPolicyGate({
    getPolicy: async () => next,
    getIdentity: () => 1,
    getAppVersion: () => "1.11.0",
  });
  await assert.rejects(gate.authorize("transcription", "base"), {
    code: "POLICY_APP_VERSION_BLOCKED",
  });
});

test("a failed authoritative lookup retires the previous authorization", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let fail = false;
  const gate = createLocalModelPolicyGate({
    getPolicy: async () => {
      if (fail) throw new Error("lookup failed");
      return state();
    },
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
  });
  const lease = await gate.authorize("transcription", "base");
  fail = true;
  await assert.rejects(gate.resolve(), { code: "POLICY_UNRESOLVABLE" });
  assert.throws(() => gate.assertCurrent(lease), { code: "POLICY_UNRESOLVABLE" });
  gate.release(lease);
});
