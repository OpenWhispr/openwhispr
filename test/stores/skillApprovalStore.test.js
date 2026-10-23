const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const load = () => import("../../src/stores/skillApprovalStore.ts");

const PROPOSAL = {
  title: "Follow-up email from notes",
  description: "Drafts a follow-up email after a call, from that call's notes.",
  instructions: "## Steps\n1. Read the call's notes.\n",
  files: [],
};

const NEW_SKILL = { name: "follow-up-email-from-notes", existing: false, problems: [] };

// The skills IPC as main serves it, with the connector calls a skill card must never make.
function fakeElectron(
  saveResult = { ok: true, name: "follow-up-email-from-notes" },
  check = () => NEW_SKILL,
  undoResult = { ok: true }
) {
  const calls = { save: [], undo: [], check: [], connector: [] };
  const connector = (name) => async () => {
    calls.connector.push(name);
    return {};
  };
  return {
    calls,
    api: {
      skillsSaveProposal: async (proposal) => {
        calls.save.push(proposal);
        return saveResult;
      },
      skillsCheckProposal: async (request) => {
        calls.check.push(request);
        return check(request.proposal);
      },
      skillsUndo: async (name, versionId) => {
        calls.undo.push([name, versionId]);
        return undoResult;
      },
      connectorPrepare: connector("connectorPrepare"),
      connectorCommit: connector("connectorCommit"),
      connectorCancel: connector("connectorCancel"),
    },
  };
}

function context(toolCallId, controller = new AbortController()) {
  let requested = 0;
  return {
    controller,
    requestedCount: () => requested,
    value: {
      messageId: "m1",
      toolCallId,
      signal: controller.signal,
      onApprovalRequested: () => {
        requested += 1;
      },
    },
  };
}

const CREATE = { kind: "create", name: "follow-up-email-from-notes", draft: PROPOSAL };

async function freshStore(t, electron = fakeElectron()) {
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await load();
  store.useSkillApprovalStore.setState({ entries: {} });
  const entryOf = (toolCallId) =>
    store.useSkillApprovalStore.getState().entries[`m1::${toolCallId}`];
  return { store, entryOf, calls: electron.calls };
}

test("a request shows a pending entry and settles once", async (t) => {
  const { store, entryOf, calls } = await freshStore(t);
  const ctx = context("call-1");

  const outcome = store.requestSkillApproval(ctx.value, CREATE);

  const pending = entryOf("call-1");
  assert.deepEqual(
    [pending.state, pending.kind, pending.name, pending.draft, pending.original],
    ["pending", "create", "follow-up-email-from-notes", PROPOSAL, PROPOSAL]
  );
  assert.equal(ctx.requestedCount(), 1);
  await store.saveSkillApproval(pending.key);
  await store.saveSkillApproval(pending.key);
  store.skipSkillApproval(pending.key);

  assert.deepEqual(await outcome, {
    state: "saved",
    name: "follow-up-email-from-notes",
    edited: false,
  });
  assert.equal(entryOf("call-1").state, "saved");
  assert.equal(calls.save.length, 1);
});

test("Skip and expiry resolve without writing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, entryOf, calls } = await freshStore(t);

  const skipped = store.requestSkillApproval(context("call-1").value, CREATE);
  store.skipSkillApproval(entryOf("call-1").key);
  const expired = store.requestSkillApproval(context("call-2").value, CREATE);
  t.mock.timers.tick(10 * 60 * 1000);

  assert.deepEqual(await skipped, { state: "skipped" });
  assert.deepEqual(await expired, { state: "not_saved", reason: "expired" });
  assert.deepEqual([entryOf("call-1").state, entryOf("call-2").state], ["skipped", "not_saved"]);
  assert.deepEqual(calls.save, []);
});

test("a cancelled turn withdraws a pending card", async (t) => {
  const { store, entryOf, calls } = await freshStore(t);
  const ctx = context("call-1");

  const outcome = store.requestSkillApproval(ctx.value, CREATE);
  ctx.controller.abort();

  assert.deepEqual(await outcome, { state: "not_saved", reason: "conversation_ended" });
  assert.equal(entryOf("call-1").state, "not_saved");
  await store.saveSkillApproval(entryOf("call-1").key);
  assert.deepEqual(calls.save, [], "a withdrawn card can't be saved");

  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await store.requestSkillApproval(context("call-2", aborted).value, CREATE), {
    state: "not_saved",
    reason: "conversation_ended",
  });
  assert.equal(entryOf("call-2"), undefined);
});

test("saving writes the edited draft and reports the edit", async (t) => {
  const { store, entryOf, calls } = await freshStore(t);

  const outcome = store.requestSkillApproval(context("call-1").value, CREATE);
  const { key } = entryOf("call-1");
  store.updateSkillDraft(key, { title: "Call follow-up", description: "After calls." });
  await store.saveSkillApproval(key);

  assert.deepEqual(calls.save, [
    { ...PROPOSAL, title: "Call follow-up", description: "After calls." },
  ]);
  assert.deepEqual(await outcome, {
    state: "saved",
    name: "follow-up-email-from-notes",
    edited: true,
  });
  assert.equal(entryOf("call-1").original.title, PROPOSAL.title);
});

test("a save main refuses shows as failed", async (t) => {
  const electron = fakeElectron({ ok: false, error: "noSpace" });
  const { store, entryOf } = await freshStore(t, electron);

  const outcome = store.requestSkillApproval(context("call-1").value, CREATE);
  await store.saveSkillApproval(entryOf("call-1").key);

  assert.deepEqual(await outcome, { state: "failed" });
  assert.equal(entryOf("call-1").state, "failed");
});

test("Save sends the hash the card was made against, and a changed skill ends the card", async (t) => {
  const electron = fakeElectron({ ok: false, error: "changed" }, () => ({
    name: "weekly-recap",
    existing: true,
    problems: [],
    hash: "h2",
  }));
  const { store, entryOf, calls } = await freshStore(t, electron);
  const request = { ...CREATE, name: "weekly-recap", replacesExisting: true, baseHash: "h1" };

  const outcome = store.requestSkillApproval(context("call-1").value, request);
  await store.saveSkillApproval(entryOf("call-1").key);

  assert.deepEqual(calls.save, [{ ...PROPOSAL, baseHash: "h1" }]);
  assert.deepEqual(await outcome, { state: "changed" });
  assert.equal(entryOf("call-1").state, "outdated");
});

test("an edited title that names a skill takes that skill's hash for the next Save", async (t) => {
  const electron = fakeElectron(undefined, () => ({
    name: "weekly-recap",
    existing: true,
    problems: [],
    hash: "h1",
  }));
  const { store, entryOf, calls } = await freshStore(t, electron);

  store.requestSkillApproval(context("call-1").value, CREATE);
  const { key } = entryOf("call-1");
  await store.saveSkillApproval(key);
  assert.deepEqual(calls.save, []);
  assert.equal(entryOf("call-1").baseHash, "h1");

  await store.saveSkillApproval(key);
  assert.deepEqual(calls.save, [{ ...PROPOSAL, baseHash: "h1" }]);
});

test("a duplicate tool call doesn't steal the first card", async (t) => {
  const { store, entryOf } = await freshStore(t);

  const first = store.requestSkillApproval(context("call-1").value, CREATE);
  const duplicate = await store.requestSkillApproval(context("call-1").value, {
    ...CREATE,
    name: "other",
  });

  assert.deepEqual(duplicate, { state: "not_saved", reason: "duplicate_tool_call" });
  assert.equal(entryOf("call-1").name, "follow-up-email-from-notes");
  store.skipSkillApproval(entryOf("call-1").key);
  assert.deepEqual(await first, { state: "skipped" });
});

test("approving a skill card never calls the connector IPC", async (t) => {
  const { store, entryOf, calls } = await freshStore(t);

  const saved = store.requestSkillApproval(context("call-1").value, CREATE);
  await store.saveSkillApproval(entryOf("call-1").key);
  const skipped = store.requestSkillApproval(context("call-2").value, CREATE);
  store.skipSkillApproval(entryOf("call-2").key);
  const ctx = context("call-3");
  const withdrawn = store.requestSkillApproval(ctx.value, CREATE);
  ctx.controller.abort();
  await Promise.all([saved, skipped, withdrawn]);

  assert.deepEqual(calls.connector, []);
});

test("a save that replaced a skill keeps its version, and Undo puts it back", async (t) => {
  const electron = fakeElectron({
    ok: true,
    name: "follow-up-email-from-notes",
    versionId: "1760950800000",
  });
  const { store, entryOf, calls } = await freshStore(t, electron);

  void store.requestSkillApproval(context("call-1").value, { ...CREATE, replacesExisting: true });
  await store.saveSkillApproval(entryOf("call-1").key);
  assert.equal(entryOf("call-1").versionId, "1760950800000");
  await store.undoSkillApproval(entryOf("call-1").key);

  assert.deepEqual(calls.undo, [["follow-up-email-from-notes", "1760950800000"]]);
  assert.equal(entryOf("call-1").state, "undone");
});

test("an edited title naming an existing skill asks again before replacing it", async (t) => {
  const meetingPrep = { name: "meeting-prep", existing: true, problems: [] };
  const electron = fakeElectron(undefined, (proposal) =>
    proposal.title === "Meeting prep" ? meetingPrep : NEW_SKILL
  );
  const { store, entryOf, calls } = await freshStore(t, electron);

  void store.requestSkillApproval(context("call-1").value, CREATE);
  const { key } = entryOf("call-1");
  store.updateSkillDraft(key, { title: "Meeting prep" });
  await store.saveSkillApproval(key);

  assert.deepEqual(calls.save, [], "nothing is written yet");
  assert.equal(entryOf("call-1").state, "pending");
  assert.equal(entryOf("call-1").name, "meeting-prep");
  assert.equal(entryOf("call-1").replacesExisting, true, "the card now says it replaces it");

  await store.saveSkillApproval(key);
  assert.equal(calls.save.length, 1, "Save with the notice showing writes");
});

test("a refused Undo says the skill has changed since", async (t) => {
  const replaced = { ok: true, name: "follow-up-email-from-notes", versionId: "1760950800000" };
  const electron = fakeElectron(replaced, undefined, { ok: false, error: "invalid" });
  const { store, entryOf } = await freshStore(t, electron);

  void store.requestSkillApproval(context("call-1").value, { ...CREATE, replacesExisting: true });
  await store.saveSkillApproval(entryOf("call-1").key);
  await store.undoSkillApproval(entryOf("call-1").key);

  assert.equal(entryOf("call-1").state, "changed_since");
});

test("a save main refuses for the card's text keeps the card open with why", async (t) => {
  const problems = [{ code: "descriptionAngleBrackets" }];
  const { store, entryOf, calls } = await freshStore(t, fakeElectron({ ok: false, problems }));

  const outcome = store.requestSkillApproval(context("call-1").value, CREATE);
  const { key } = entryOf("call-1");
  store.updateSkillDraft(key, { description: "Use for <weekly> reports" });
  await store.saveSkillApproval(key);

  assert.equal(entryOf("call-1").state, "pending", "the user can fix it and save again");
  assert.deepEqual(entryOf("call-1").problems, problems);
  assert.equal(calls.save.length, 1);
  store.skipSkillApproval(key);
  assert.deepEqual(await outcome, { state: "skipped" });
});

test("a turn that ends while Save checks the name doesn't reopen the card", async (t) => {
  let answer;
  const pendingCheck = new Promise((resolve) => (answer = resolve));
  const electron = fakeElectron(undefined, () => pendingCheck);
  const { store, entryOf, calls } = await freshStore(t, electron);
  const ctx = context("call-1");

  const outcome = store.requestSkillApproval(ctx.value, CREATE);
  const saving = store.saveSkillApproval(entryOf("call-1").key);
  ctx.controller.abort();
  answer({ name: "meeting-prep", existing: true, problems: [] });
  await saving;

  assert.deepEqual(await outcome, { state: "not_saved", reason: "conversation_ended" });
  assert.equal(entryOf("call-1").state, "not_saved");
  assert.deepEqual(calls.save, []);
});
