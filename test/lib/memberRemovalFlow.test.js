const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/lib/memberRemovalFlow.ts");

const member = (user_id, name, role = "member") => ({
  user_id,
  name,
  email: `${user_id}@example.com`,
  role,
  joined_at: "2026-01-01",
  image: null,
});
const SELF = member("u-self", "Ronnie", "admin");
const LIAM = member("u-liam", "Liam");
const ALEX = member("u-alex", "Alex");
const ZOE = member("u-zoe", "Zoe");
const OWNER = member("u-owner", "Bea", "owner");
const ROSTER = [ZOE, LIAM, SELF, OWNER, ALEX];

const owns = (user_id, owned_notes = 1, owned_spaces = 0) => ({
  user_id,
  owned_notes,
  owned_spaces,
});
const run = (reducer, events, start = { kind: "closed" }) => events.reduce(reducer, start);
const open = (subjects = [LIAM, ALEX]) => ({
  type: "open",
  subjects,
  defaultOwnerId: SELF.user_id,
});

test("opening checks first", async () => {
  const { memberRemovalReducer, needsTransfer } = await load();

  const state = memberRemovalReducer({ kind: "closed" }, open());

  assert.deepEqual(state, {
    kind: "checking",
    subjects: [LIAM, ALEX],
    owners: [],
    transferTo: null,
    defaultOwnerId: SELF.user_id,
  });
  assert.equal(needsTransfer(state), false);
});

test("a preview with owners defaults the new owner to you", async () => {
  const { memberRemovalReducer, needsTransfer } = await load();

  const state = run(memberRemovalReducer, [
    open(),
    { type: "previewed", owners: [owns("u-liam", 3, 1)] },
  ]);

  assert.equal(state.kind, "confirm");
  assert.deepEqual(state.owners, [owns("u-liam", 3, 1)]);
  assert.equal(state.transferTo, SELF.user_id);
  assert.equal(needsTransfer(state), true);
});

test("a preview without content offers the plain removal", async () => {
  const { memberRemovalReducer, needsTransfer } = await load();

  const state = run(memberRemovalReducer, [
    open(),
    { type: "previewed", owners: [owns("u-liam", 0, 0), owns("u-alex", 0, 0)] },
  ]);

  assert.equal(state.kind, "confirm");
  assert.deepEqual(state.owners, []);
  assert.equal(state.transferTo, null);
  assert.equal(needsTransfer(state), false);
});

test("preview entries that name nobody are dropped", async () => {
  const { memberRemovalReducer } = await load();

  const state = run(memberRemovalReducer, [
    open(),
    { type: "previewed", owners: [null, "u-liam", { owned_notes: 2 }, owns("u-alex", 0, 2)] },
  ]);

  assert.deepEqual(state.owners, [owns("u-alex", 0, 2)]);
});

test("a failed preview still offers removal", async () => {
  const { memberRemovalReducer, needsTransfer } = await load();

  const state = run(memberRemovalReducer, [open(), { type: "previewFailed" }]);

  assert.equal(state.kind, "confirm");
  assert.deepEqual(state.owners, []);
  assert.equal(needsTransfer(state), false);
});

test("a preview that lands after the dialog moved on is ignored", async () => {
  const { memberRemovalReducer } = await load();
  const confirm = run(memberRemovalReducer, [open(), { type: "previewFailed" }]);

  assert.equal(
    memberRemovalReducer(confirm, { type: "previewed", owners: [owns("u-liam")] }),
    confirm
  );
  assert.deepEqual(memberRemovalReducer({ kind: "closed" }, { type: "previewFailed" }), {
    kind: "closed",
  });
});

test("picking an owner works in confirm and failed only", async () => {
  const { memberRemovalReducer } = await load();
  const confirm = run(memberRemovalReducer, [
    open(),
    { type: "previewed", owners: [owns("u-liam")] },
  ]);

  const picked = memberRemovalReducer(confirm, { type: "pickOwner", userId: ZOE.user_id });
  assert.equal(picked.transferTo, ZOE.user_id);

  const failed = run(
    memberRemovalReducer,
    [
      { type: "confirm" },
      { type: "failed", error: { kind: "failed" } },
      { type: "pickOwner", userId: OWNER.user_id },
    ],
    picked
  );
  assert.equal(failed.kind, "failed");
  assert.equal(failed.transferTo, OWNER.user_id);

  const running = memberRemovalReducer(picked, { type: "confirm" });
  assert.equal(memberRemovalReducer(running, { type: "pickOwner", userId: SELF.user_id }), running);
  const checking = memberRemovalReducer({ kind: "closed" }, open());
  assert.equal(
    memberRemovalReducer(checking, { type: "pickOwner", userId: ZOE.user_id }),
    checking
  );
});

test("confirm runs from confirm or failed and clears the error", async () => {
  const { memberRemovalReducer } = await load();
  const confirm = run(memberRemovalReducer, [open(), { type: "previewFailed" }]);

  const running = memberRemovalReducer(confirm, { type: "confirm" });
  assert.equal(running.kind, "running");

  const failed = memberRemovalReducer(running, { type: "failed", error: { kind: "failed" } });
  assert.deepEqual(failed.error, { kind: "failed" });

  const retrying = memberRemovalReducer(failed, { type: "confirm" });
  assert.equal(retrying.kind, "running");
  assert.equal(retrying.error, undefined);
  assert.equal("error" in retrying, false);

  const checking = memberRemovalReducer({ kind: "closed" }, open());
  assert.equal(memberRemovalReducer(checking, { type: "confirm" }), checking);
});

test("a transfer_required answer switches to the transfer branch", async () => {
  const { memberRemovalReducer, needsTransfer } = await load();

  const state = run(memberRemovalReducer, [
    open(),
    { type: "previewFailed" },
    { type: "confirm" },
    { type: "failed", error: { kind: "transferRequired", owners: [owns("u-alex", 0, 1)] } },
  ]);

  assert.equal(state.kind, "confirm");
  assert.deepEqual(state.owners, [owns("u-alex", 0, 1)]);
  assert.equal(state.transferTo, SELF.user_id);
  assert.equal(state.error, undefined);
  assert.equal(needsTransfer(state), true);
});

test("a transfer_required answer without a readable list asks a new owner for everyone", async () => {
  const { memberRemovalReducer, needsTransfer } = await load();

  const state = run(memberRemovalReducer, [
    open(),
    { type: "previewFailed" },
    { type: "confirm" },
    { type: "failed", error: { kind: "transferRequired", owners: [] } },
  ]);

  assert.equal(state.kind, "confirm");
  assert.deepEqual(
    state.owners.map((owner) => owner.user_id),
    ["u-liam", "u-alex"]
  );
  assert.equal(needsTransfer(state), true);
});

test("a vanished new owner falls back to you and keeps the dialog open", async () => {
  const { memberRemovalReducer } = await load();
  const error = { kind: "invalidTransferTarget" };

  const state = run(memberRemovalReducer, [
    open(),
    { type: "previewed", owners: [owns("u-liam")] },
    { type: "pickOwner", userId: ZOE.user_id },
    { type: "confirm" },
    { type: "failed", error },
  ]);

  assert.equal(state.kind, "failed");
  assert.equal(state.transferTo, SELF.user_id);
  assert.deepEqual(state.error, error);
  assert.deepEqual(state.owners, [owns("u-liam")]);
});

test("any other failure keeps the pick", async () => {
  const { memberRemovalReducer } = await load();

  const state = run(memberRemovalReducer, [
    open(),
    { type: "previewed", owners: [owns("u-liam")] },
    { type: "pickOwner", userId: ZOE.user_id },
    { type: "confirm" },
    { type: "failed", error: { kind: "cannotRemove", reason: "owner" } },
  ]);

  assert.equal(state.kind, "failed");
  assert.equal(state.transferTo, ZOE.user_id);
  assert.deepEqual(state.error, { kind: "cannotRemove", reason: "owner" });
});

test("succeeded closes a running removal only", async () => {
  const { memberRemovalReducer } = await load();
  const confirm = run(memberRemovalReducer, [open(), { type: "previewFailed" }]);

  assert.equal(memberRemovalReducer(confirm, { type: "succeeded" }), confirm);
  assert.deepEqual(
    run(memberRemovalReducer, [{ type: "confirm" }, { type: "succeeded" }], confirm),
    { kind: "closed" }
  );
});

test("dismiss is ignored while running", async () => {
  const { memberRemovalReducer } = await load();
  const confirm = run(memberRemovalReducer, [open(), { type: "previewFailed" }]);
  const running = memberRemovalReducer(confirm, { type: "confirm" });

  assert.equal(memberRemovalReducer(running, { type: "dismiss" }), running);
  assert.deepEqual(memberRemovalReducer(confirm, { type: "dismiss" }), { kind: "closed" });
  assert.deepEqual(
    memberRemovalReducer(memberRemovalReducer({ kind: "closed" }, open()), { type: "dismiss" }),
    { kind: "closed" }
  );
});

test("opening is ignored while running", async () => {
  const { memberRemovalReducer } = await load();
  const running = run(memberRemovalReducer, [
    open(),
    { type: "previewFailed" },
    { type: "confirm" },
  ]);

  assert.equal(memberRemovalReducer(running, open([ZOE])), running);
});

test("opening again from confirm checks the new people", async () => {
  const { memberRemovalReducer } = await load();
  const confirm = run(memberRemovalReducer, [
    open(),
    { type: "previewed", owners: [owns("u-liam")] },
  ]);

  const state = memberRemovalReducer(confirm, open([ZOE]));

  assert.equal(state.kind, "checking");
  assert.deepEqual(state.subjects, [ZOE]);
  assert.deepEqual(state.owners, []);
  assert.equal(state.transferTo, null);
});

test("candidates leave out the people being removed and put you first", async () => {
  const { memberRemovalReducer, ownerCandidates } = await load();
  const state = memberRemovalReducer({ kind: "closed" }, open());

  assert.deepEqual(
    ownerCandidates(ROSTER, state).map((m) => m.user_id),
    ["u-self", "u-owner", "u-zoe"]
  );
  assert.deepEqual(ownerCandidates(ROSTER, { kind: "closed" }), []);
});

test("candidates without a name sort by email", async () => {
  const { memberRemovalReducer, ownerCandidates } = await load();
  const state = memberRemovalReducer({ kind: "closed" }, open([ZOE]));
  const nameless = { ...member("u-anna", null), email: "anna@example.com" };

  assert.deepEqual(
    ownerCandidates([...ROSTER, nameless], state).map((m) => m.user_id),
    ["u-self", "u-alex", "u-anna", "u-owner", "u-liam"]
  );
});
