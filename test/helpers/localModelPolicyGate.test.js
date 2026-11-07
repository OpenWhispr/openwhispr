const test = require("node:test");
const assert = require("node:assert/strict");
const { managedPolicy } = require("./harness/policyFixtures");

const settle = () => new Promise((done) => setImmediate(done));
// Loads the rules a verdict is read with; the lookup itself may refuse.
const settleRules = (gate) => gate.resolve({ memoryOnly: true }).catch(() => {});

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
    await assert.rejects(gate.authorize("transcription", " base "), (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /[Uu]nknown.*model/);
      return true;
    });
  }
});

test("a blank model is refused only under a managed policy; otherwise engine defaults apply", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  const gateFor = (snapshot) =>
    createLocalModelPolicyGate({
      getPolicy: async () => snapshot,
      getIdentity: () => 1,
      getAppVersion: () => "1.11.1",
    });
  for (const blankId of ["", "   ", "\t\n", undefined]) {
    await assert.rejects(gateFor(state(["base"])).authorize("transcription", blankId), {
      code: "POLICY_MODEL_BLOCKED",
    });
    const unmanaged = gateFor({ success: true, managed: false });
    unmanaged.release(await unmanaged.authorize("transcription", blankId));
  }

  const unmanaged = gateFor({ success: true, managed: false });
  const lease = await unmanaged.authorize("transcription", "");
  unmanaged.update(state(["base"], 2, undefined));
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => unmanaged.assertCurrent(lease), { code: "POLICY_MODEL_BLOCKED" });
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
  // The held verdict answered; the managed one lands behind it.
  await settle();
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
  gate.update(next);
  const restored = await gate.authorize("transcription", "base");
  identity++;
  gate.invalidate();
  // A new credential waits for its verdict; the work it found keeps running.
  assert.doesNotThrow(() => gate.assertCurrent(restored));
  await assert.rejects(gate.authorize("transcription", "base"), { code: "POLICY_UNRESOLVABLE" });
  // Only an account change ends that work.
  gate.cancelJobs();
  assert.equal(restored.signal.aborted, true);
  assert.throws(() => gate.assertCurrent(restored), { code: "POLICY_UNRESOLVABLE" });
});

test("delayed policy from a previous identity never authorizes a new action", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  const lookups = [];
  let identity = 1;
  const gate = createLocalModelPolicyGate({
    getPolicy: () =>
      new Promise((done) => {
        lookups.push(done);
      }),
    getIdentity: () => identity,
    getAppVersion: () => "1.11.1",
  });
  const pending = gate.authorize("transcription", "base");
  await new Promise((done) => setImmediate(done));
  identity++;
  gate.invalidate();
  // Without a generation to give it away: only the lookup's own epoch can.
  const { authGeneration, ...delayed } = state();
  assert.equal(authGeneration, 1);
  lookups[0](delayed);
  await assert.rejects(pending, { code: "POLICY_UNRESOLVABLE" });
  assert.throws(() => gate.authorizeCached("transcription", "base"), {
    code: "POLICY_UNRESOLVABLE",
  });
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

test("a failed lookup says nothing new: held verdicts and running work stand", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let lookup = async () => state();
  const onChange = [];
  const gate = createLocalModelPolicyGate({
    getPolicy: () => lookup(),
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
    onChange: () => onChange.push("changed"),
  });
  const lease = await gate.authorize("transcription", "base");
  onChange.length = 0;
  for (const failed of [
    async () => {
      throw new Error("lookup failed");
    },
    async () => ({ success: false, code: "POLICY_UNAVAILABLE" }),
  ]) {
    lookup = failed;
    await gate.resolve({ refresh: true });
    assert.equal(lease.signal.aborted, false);
    assert.doesNotThrow(() => gate.assertCurrent(lease));
    assert.equal(gate.failure("transcription", "base"), null);
  }
  assert.deepEqual(onChange, []);
  gate.release(lease);
});

test("the server calling a policy unresolvable refuses new work and stops nothing", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  const onChange = [];
  const gate = createLocalModelPolicyGate({
    getPolicy: async () => ({ success: true, managed: false, authGeneration: 1, revision: 1 }),
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
    onChange: () => onChange.push("changed"),
  });
  const lease = await gate.authorize("transcription", "base");
  await settle();
  onChange.length = 0;

  gate.update({ success: false, code: "POLICY_UNRESOLVABLE", authGeneration: 1, revision: 1 });

  assert.equal(gate.failure("transcription", "base").code, "POLICY_UNRESOLVABLE");
  assert.equal(lease.signal.aborted, false);
  assert.doesNotThrow(() => gate.assertCurrent(lease));
  assert.deepEqual(onChange, []);
  gate.release(lease);
});

test("a token rotation holds new work, keeps running work, and the next verdict decides it", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let identity = 1;
  const lookups = [];
  const onChange = [];
  const gate = createLocalModelPolicyGate({
    getPolicy: () => new Promise((done) => lookups.push(done)),
    getIdentity: () => identity,
    getAppVersion: () => "1.11.1",
    onChange: () => onChange.push(gate.failure("transcription", "base")?.code ?? null),
  });
  gate.update(state());
  await settleRules(gate);
  const lease = gate.authorizeCached("transcription", "base");
  onChange.length = 0;

  identity = 2;
  gate.invalidate();

  assert.equal(lookups.length, 1, "the re-resolve starts at once");
  assert.equal(gate.failure("transcription", "base").code, "POLICY_UNRESOLVABLE");
  assert.equal(lease.signal.aborted, false);
  assert.doesNotThrow(() => gate.assertCurrent(lease));
  assert.deepEqual(onChange, [], "an unresolved verdict reports nothing to stop");

  lookups[0](state([], 2, 2));
  await settle();

  assert.equal(lease.signal.reason?.code, "POLICY_MODEL_BLOCKED");
  assert.deepEqual(onChange, ["POLICY_MODEL_BLOCKED"]);
});

test("an account change cancels running work before the new verdict, which then authorizes only new work", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let identity = 1;
  const gate = createLocalModelPolicyGate({
    getPolicy: () => new Promise(() => {}),
    getIdentity: () => identity,
    getAppVersion: () => "1.11.1",
  });
  gate.update({ success: true, managed: false, authGeneration: 1, revision: 1 });
  await settleRules(gate);
  const oldAccountJob = gate.authorizeCached("transcription", "base");

  identity = 2;
  gate.cancelJobs();
  assert.equal(oldAccountJob.signal.reason?.code, "POLICY_UNRESOLVABLE");
  gate.invalidate();
  assert.throws(() => gate.assertCurrent(oldAccountJob), { code: "POLICY_UNRESOLVABLE" });

  gate.update({ success: true, managed: false, authGeneration: 2, revision: 2 });
  assert.throws(() => gate.assertCurrent(oldAccountJob), { code: "POLICY_UNRESOLVABLE" });
  gate.release(gate.authorizeCached("transcription", "base"));
});

test("a held verdict answers without waiting; one refresh runs behind it and its denial revokes", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  const lookups = [];
  let held = true;
  const gate = createLocalModelPolicyGate({
    getPolicy: () =>
      held
        ? Promise.resolve({ success: true, managed: false, authGeneration: 1, revision: 1 })
        : new Promise((done) => lookups.push(done)),
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
  });
  gate.release(await gate.authorize("transcription", "base"));
  await settle();
  held = false;

  const startedAt = performance.now();
  const leases = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    leases.push(await gate.authorize("transcription", "base"));
  }
  assert.ok(performance.now() - startedAt < 100, "must not wait on the network");
  assert.equal(lookups.length, 1, "refreshes are deduped");

  lookups[0](state([], 2));
  await settle();
  for (const lease of leases) {
    assert.equal(lease.signal.reason?.code, "POLICY_MODEL_BLOCKED");
  }
  await assert.rejects(gate.authorize("transcription", "base"), { code: "POLICY_MODEL_BLOCKED" });
});

test("only an identity with no verdict waits for the lookup", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let answer;
  const gate = createLocalModelPolicyGate({
    getPolicy: () =>
      new Promise((done) => {
        answer = done;
      }),
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
  });
  let settled = false;
  const pending = gate.authorize("transcription", "base").finally(() => {
    settled = true;
  });
  await settle();
  assert.equal(settled, false);
  answer({ success: true, managed: false, authGeneration: 1 });
  gate.release(await pending);
});

test("a warm-up refused before any verdict runs once on the first one", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  const gate = createLocalModelPolicyGate({
    getPolicy: async () => ({ success: false }),
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
  });
  await settleRules(gate);
  let runs = 0;
  gate.runOnceVerdictSettles(() => runs++);

  gate.update({ success: false, code: "POLICY_UNAVAILABLE", authGeneration: 1 });
  gate.update({ success: false, code: "POLICY_UNRESOLVABLE", authGeneration: 1 });
  assert.equal(runs, 0, "neither failure is a settled verdict");

  gate.update({ success: true, managed: false, authGeneration: 1, revision: 1 });
  gate.update({ success: true, managed: false, authGeneration: 1, revision: 2 });
  assert.equal(runs, 1);

  // A verdict that landed before the warm-up could ask needs no waiting.
  gate.runOnceVerdictSettles(() => runs++);
  assert.equal(runs, 2);
});

test("a verdict landing before the rules load isn't read as a denial, and is applied once they do", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  const decisions = [];
  const gate = createLocalModelPolicyGate({
    getPolicy: async () => ({ success: false }),
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
    onChange: () => decisions.push(gate.failure("transcription", "base")?.code ?? null),
  });
  gate.update({ success: true, managed: false, authGeneration: 1 });
  assert.deepEqual(decisions, []);
  await settleRules(gate);
  assert.deepEqual(decisions, [null]);
});

test("the periodic refresh reaches the server on every tick, inside the policy manager's freshness window", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  const { createWorkspacePolicyManager } = require("../../src/helpers/workspacePolicyManager");
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "policy-refresh-"));
  t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));

  const FIVE_MINUTES = 5 * 60 * 1000;
  let clock = 0;
  let fetches = 0;
  const manager = createWorkspacePolicyManager({
    cachePath: path.join(tempDirectory, "workspace-policy.json"),
    getApiUrl: () => "https://api.openwhispr.test",
    getAppVersion: () => "1.11.1",
    proxyFetch: async () => {
      fetches++;
      return new Response(
        JSON.stringify({ data: { managed: false, policy: null, policyUpdatedAt: null } }),
        { status: 200 }
      );
    },
    tokenStore: { getState: () => ({ token: "token", generation: 1 }) },
    now: () => clock,
  });
  const gate = createLocalModelPolicyGate({
    getPolicy: (options) => manager.getPolicy({ expectedAuthGeneration: 1, ...options }),
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
  });

  t.mock.timers.enable({ apis: ["setInterval"] });
  const timer = gate.startPeriodicRefresh(FIVE_MINUTES);
  t.after(() => clearInterval(timer));

  await gate.resolve();
  assert.equal(fetches, 1);
  for (let tick = 2; tick <= 6; tick++) {
    // A timer firing just inside the window would find the last answer still fresh.
    clock += FIVE_MINUTES - 1000;
    t.mock.timers.tick(FIVE_MINUTES);
    await settle();
    assert.equal(fetches, tick);
  }
});

test("a lookup replaced for the same credential answers from its replacement", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  const answers = [];
  const gate = createLocalModelPolicyGate({
    getPolicy: () => new Promise((resolve) => answers.push(resolve)),
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
  });
  const authorized = gate.authorize("transcription", "base");
  await settle();
  gate.invalidate();
  await settle();
  answers[0](state());
  answers[1](state());
  const lease = await authorized;
  gate.release(lease);
});

test("work run under a running lease keeps its verdict across a rotation with no new answer", async () => {
  const {
    createLocalModelPolicyGate,
    runLocalModelOperation,
  } = require("../../src/helpers/localModelPolicyGate");
  let identity = 1;
  let lookups = 0;
  const gate = createLocalModelPolicyGate({
    getPolicy: async () => {
      lookups += 1;
      if (lookups === 1) return state(["base"], 1, identity);
      throw new Error("offline");
    },
    getIdentity: () => identity,
    getAppVersion: () => "1.11.1",
  });
  const owner = { localModelPolicy: gate };
  const lease = await gate.authorize("transcription", "base");
  identity = 2;
  gate.invalidate();
  await settle();

  await assert.rejects(
    runLocalModelOperation(owner, "transcription", "base", async () => "ran"),
    { code: "POLICY_UNRESOLVABLE" }
  );
  assert.equal(
    await gate.runWithLease(lease, () =>
      runLocalModelOperation(owner, "transcription", "base", async () => "ran")
    ),
    "ran"
  );
  gate.release(lease);
});

test("a verdict held on disk answers at once, and the refresh behind it can still revoke", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let answer;
  let lookups = 0;
  const gate = createLocalModelPolicyGate({
    getPolicy: () => {
      lookups++;
      return new Promise((done) => {
        answer = done;
      });
    },
    getHeldPolicy: async () => state(["base"], 1),
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
  });

  const lease = await gate.authorize("transcription", "base");
  assert.equal(lookups, 1, "the refresh still goes out");

  answer(state(["small"], 2));
  await settle();
  assert.equal(lease.signal.reason?.code, "POLICY_MODEL_BLOCKED");
});

test("with nothing held on disk, an identity still waits for the lookup", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let answer;
  const gate = createLocalModelPolicyGate({
    getPolicy: () =>
      new Promise((done) => {
        answer = done;
      }),
    getHeldPolicy: async () => ({ success: false }),
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
  });
  let settled = false;
  const pending = gate.authorize("transcription", "base").finally(() => {
    settled = true;
  });
  await settle();
  assert.equal(settled, false);
  answer({ success: true, managed: false, authGeneration: 1 });
  gate.release(await pending);
});

test("a held verdict read for a previous identity never lands", async () => {
  const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
  let identity = 1;
  let answerHeld;
  const gate = createLocalModelPolicyGate({
    getPolicy: async () => ({ success: false }),
    getHeldPolicy: () =>
      new Promise((done) => {
        answerHeld = done;
      }),
    getIdentity: () => identity,
    getAppVersion: () => "1.11.1",
  });

  const pending = gate.authorize("transcription", "base");
  await settle();
  identity = 2;
  answerHeld({ success: true, managed: false });

  await assert.rejects(pending, { code: "POLICY_UNRESOLVABLE" });
});
