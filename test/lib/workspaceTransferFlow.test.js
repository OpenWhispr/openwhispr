const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/lib/workspaceTransferFlow.ts");

const run = (reducer, events, start = { kind: "closed" }) => events.reduce(reducer, start);

const member = (user_id, role, name, email = `${user_id}@example.com`) => ({
  user_id,
  role,
  name,
  email,
});

test("transferCandidates excludes self and the owner and lists admins first", async () => {
  const { transferCandidates } = await load();
  const members = [
    member("u-owner", "owner", "Olivia"),
    member("u-self", "admin", "Sam"),
    member("u-m2", "member", "Zed"),
    member("u-a2", "admin", null, "zoe@example.com"),
    member("u-m1", "member", "Amy"),
    member("u-a1", "admin", "Ben"),
  ];

  const ids = transferCandidates(members, "u-self").map((m) => m.user_id);

  // Admins by name or email, then members by name.
  assert.deepEqual(ids, ["u-a1", "u-a2", "u-m1", "u-m2"]);
});

test("open with a preselected member goes straight to the confirm copy", async () => {
  const { transferReducer } = await load();

  assert.deepEqual(transferReducer({ kind: "closed" }, { type: "open", candidateId: "u1" }), {
    kind: "choosing",
    candidateId: "u1",
  });
  assert.deepEqual(transferReducer({ kind: "closed" }, { type: "open" }), {
    kind: "choosing",
    candidateId: null,
  });
});

test("pick then confirm transfers; success is a dismiss", async () => {
  const { transferReducer } = await load();

  const transferring = run(transferReducer, [
    { type: "open" },
    { type: "pick", candidateId: "u1" },
    { type: "confirm" },
  ]);
  assert.deepEqual(transferring, { kind: "transferring", candidateId: "u1" });
  assert.deepEqual(transferReducer(transferring, { type: "dismiss" }), { kind: "closed" });
});

test("confirm without a candidate does nothing", async () => {
  const { transferReducer } = await load();

  const state = run(transferReducer, [{ type: "open" }, { type: "confirm" }]);

  assert.deepEqual(state, { kind: "choosing", candidateId: null });
});

test("pick is ignored while transferring", async () => {
  const { transferReducer } = await load();
  const transferring = { kind: "transferring", candidateId: "u1" };

  assert.equal(transferReducer(transferring, { type: "pick", candidateId: "u2" }), transferring);
});

test("failed then confirm retries with the same candidate", async () => {
  const { transferReducer } = await load();

  const failed = run(transferReducer, [
    { type: "open", candidateId: "u1" },
    { type: "confirm" },
    { type: "failed", reason: "No seats left" },
  ]);
  assert.deepEqual(failed, { kind: "failed", candidateId: "u1", reason: "No seats left" });

  assert.deepEqual(transferReducer(failed, { type: "confirm" }), {
    kind: "transferring",
    candidateId: "u1",
  });
});

test("picking after a failure goes back to choosing", async () => {
  const { transferReducer } = await load();

  const state = transferReducer(
    { kind: "failed", candidateId: "u1", reason: null },
    {
      type: "pick",
      candidateId: "u2",
    }
  );

  assert.deepEqual(state, { kind: "choosing", candidateId: "u2" });
});

test("dismiss closes a choosing or failed dialog", async () => {
  const { transferReducer } = await load();

  assert.deepEqual(
    transferReducer({ kind: "failed", candidateId: "u1", reason: null }, { type: "dismiss" }),
    {
      kind: "closed",
    }
  );
  assert.deepEqual(transferReducer({ kind: "choosing", candidateId: null }, { type: "dismiss" }), {
    kind: "closed",
  });
});

test("failed outside transferring is ignored", async () => {
  const { transferReducer } = await load();
  const choosing = { kind: "choosing", candidateId: "u1" };

  assert.equal(transferReducer(choosing, { type: "failed", reason: null }), choosing);
});
