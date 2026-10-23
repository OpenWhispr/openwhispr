const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const ARGS = {
  title: "Follow-up email from notes",
  description: "Drafts a follow-up email after a call, from that call's notes.",
  instructions: "## Steps\n1. Read the call's notes.\n",
};

// Main as it answers: a check, then a save only once the user approves.
function fakeElectron({ problems = [], saveResult } = {}) {
  const calls = { check: [], save: [] };
  return {
    calls,
    api: {
      skillsCheckProposal: async (request) => {
        calls.check.push(request);
        return { name: "follow-up-email-from-notes", existing: false, problems };
      },
      skillsSaveProposal: async (proposal) => {
        calls.save.push(proposal);
        return saveResult ?? { ok: true, name: "follow-up-email-from-notes" };
      },
    },
  };
}

async function setup(t, electron = fakeElectron()) {
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const { createProposeSkillTool } = await import("../../src/services/tools/skillTools.ts");
  const approvals = await import("../../src/stores/skillApprovalStore.ts");
  const { createToolExecutionScope } = await import(
    "../../src/components/chat/toolExecutionScope.ts"
  );
  approvals.useSkillApprovalStore.setState({ entries: {} });
  const scope = createToolExecutionScope();
  t.after(() => scope.abort());
  let next = 0;
  const propose = (args = ARGS) => {
    next += 1;
    const toolCallId = `call-${next}`;
    const result = createProposeSkillTool().execute(
      args,
      scope.createContext({ messageId: "m1", toolCallId })
    );
    return { result, key: `m1::${toolCallId}` };
  };
  const entry = (key) => approvals.useSkillApprovalStore.getState().entries[key];
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  return { propose, entry, approvals, calls: electron.calls, settled };
}

test("skill tools are offered signed out and on the free plan", async () => {
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");

  const registry = createToolRegistry({
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
    skills: {
      usable: [],
      activeNames: () => new Set(),
      read: async () => null,
      markUsed() {},
      maxTokens: 2_500,
    },
  });

  assert.ok(registry.get("propose_skill"));
  assert.equal(registry.get("email_draft"), undefined);
});

test("nothing is written before Save skill", async (t) => {
  const { propose, entry, approvals, calls, settled } = await setup(t);

  const { result, key } = propose();
  await settled();

  assert.equal(entry(key).state, "pending");
  assert.deepEqual(calls.check, [{ kind: "create", proposal: { ...ARGS, files: [] } }]);
  assert.deepEqual(calls.save, []);
  await approvals.saveSkillApproval(key);
  assert.deepEqual(await result, {
    success: true,
    data: "Saved the follow-up-email-from-notes skill. Tell the user it's saved and how it's used.",
    displayText: "",
  });
  assert.equal(calls.save.length, 1);
});

test("a proposal with problems never shows a card and tells the model what to fix", async (t) => {
  const electron = fakeElectron({ problems: [{ code: "placeholder" }, { code: "tooLarge" }] });
  const { propose, entry } = await setup(t, electron);

  const { result, key } = propose();

  assert.deepEqual(await result, {
    success: true,
    data:
      "Not proposed: placeholder, tooLarge. Fix these and call propose_skill again. " +
      "Don't mention them to the user.",
    displayText: "",
  });
  assert.equal(entry(key), undefined);
});

test("a fourth card in one answer is refused", async (t) => {
  const { propose, entry, approvals, settled } = await setup(t);

  const cards = [propose(), propose(), propose()];
  const fourth = propose();
  await settled();

  assert.deepEqual(
    cards.map(({ key }) => entry(key).state),
    ["pending", "pending", "pending"]
  );
  assert.deepEqual(await fourth.result, {
    success: false,
    data: null,
    displayText: "Only three skill cards per answer.",
  });
  for (const { key } of cards) approvals.skipSkillApproval(key);
});

test("the model hears what the user did with the card", async (t) => {
  const { propose, approvals, settled } = await setup(t);

  const edited = propose();
  const skipped = propose();
  await settled();
  approvals.updateSkillDraft(edited.key, { title: "Call follow-up" });
  await approvals.saveSkillApproval(edited.key);
  approvals.skipSkillApproval(skipped.key);

  assert.equal(
    (await edited.result).data,
    "Saved the follow-up-email-from-notes skill. Tell the user it's saved and how it's used. " +
      "The user edited it before saving."
  );
  assert.equal((await skipped.result).data, "The user skipped it. Nothing was saved.");
});

test("a save that fails tells the model to offer another try", async (t) => {
  const { propose, approvals, settled } = await setup(
    t,
    fakeElectron({ saveResult: { ok: false, error: "noSpace" } })
  );

  const card = propose();
  await settled();
  await approvals.saveSkillApproval(card.key);

  assert.equal((await card.result).data, "It couldn't be saved. Say so and offer to try again.");
});

// ---- Changing a skill (update_skill) ----

const PLAYBOOK = {
  name: "enterprise-call-playbook",
  displayName: "Enterprise call playbook",
  description: "Preps me for enterprise calls.",
  enabled: true,
  valid: true,
  addedAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
  lastUsedAt: null,
};
const OBJECTIONS = "references/objections.md";
const UPDATE_ARGS = {
  name: PLAYBOOK.name,
  intent: "Adds Acme's SSO pricing question to Objections, so the next call has the answer.",
  removals: ['the "we don\'t offer SSO" line'],
  learned_from_note_id: 7,
  files: [{ path: OBJECTIONS, content: "# Objections\n- SSO: Enterprise plan.\n" }],
};

const ACME_NOTE = { id: 7, title: "Call with Acme", created_at: "2026-10-20 09:00:00" };

function updateElectron({ note = ACME_NOTE } = {}) {
  const calls = { check: [], apply: [], reads: [] };
  const playbook = (files) => ({
    name: PLAYBOOK.name,
    displayName: PLAYBOOK.displayName,
    body: "## Steps\nAsk about budget.\n",
    files,
  });
  return {
    calls,
    api: {
      skillsReadForModel: async (ref) => {
        calls.reads.push(ref);
        const info = { path: OBJECTIONS, size: 40, text: true, script: false };
        // Too big for the withFiles read, so the tool asks for the changed file itself.
        return playbook([ref.file ? { ...info, content: "# Objections\n- No SSO.\n" } : info]);
      },
      skillsCheckProposal: async (request) => {
        calls.check.push(request);
        return { name: PLAYBOOK.name, existing: true, problems: [] };
      },
      skillsApplyUpdate: async (update) => {
        calls.apply.push(update);
        return { ok: true, name: update.name, versionId: "1760950800000" };
      },
      getNote: async (id) => (note && id === note.id ? note : null),
    },
  };
}

async function setupUpdate(t, electron = updateElectron()) {
  const context = await setup(t, electron);
  const { createUpdateSkillTool } = await import("../../src/services/tools/skillTools.ts");
  const { createToolExecutionScope } = await import(
    "../../src/components/chat/toolExecutionScope.ts"
  );
  const scope = createToolExecutionScope();
  t.after(() => scope.abort());
  const update = (args = UPDATE_ARGS, toolCallId = "update-1") => ({
    result: createUpdateSkillTool([PLAYBOOK]).execute(
      args,
      scope.createContext({ messageId: "m1", toolCallId })
    ),
    key: `m1::${toolCallId}`,
  });
  return { ...context, update, calls: electron.calls };
}

test("update_skill names only enabled skills", async () => {
  const { createUpdateSkillTool } = await import("../../src/services/tools/skillTools.ts");
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");
  const skills = (usable) => ({
    usable,
    activeNames: () => new Set(),
    read: async () => null,
    markUsed() {},
    maxTokens: 2_500,
  });
  const settings = {
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
  };

  assert.deepEqual(createUpdateSkillTool([PLAYBOOK]).parameters.properties.name.enum, [
    PLAYBOOK.name,
  ]);
  assert.ok(createToolRegistry({ ...settings, skills: skills([PLAYBOOK]) }).get("update_skill"));
  const empty = createToolRegistry({ ...settings, skills: skills([]) });
  assert.equal(empty.get("update_skill"), undefined);
});

test("the card carries intent, removals, learned-from and the current text", async (t) => {
  const { update, entry, calls, settled, approvals } = await setupUpdate(t);

  const { result, key } = update();
  await settled();

  const card = entry(key);
  assert.deepEqual(
    {
      kind: card.kind,
      name: card.name,
      displayName: card.displayName,
      intent: card.intent,
      removals: card.removals,
      learnedFrom: card.learnedFrom,
      current: card.current,
      draft: card.draft,
    },
    {
      kind: "update",
      name: PLAYBOOK.name,
      displayName: PLAYBOOK.displayName,
      intent: UPDATE_ARGS.intent,
      removals: UPDATE_ARGS.removals,
      learnedFrom: { title: "Call with Acme", createdAt: "2026-10-20 09:00:00" },
      current: {
        description: PLAYBOOK.description,
        instructions: "## Steps\nAsk about budget.\n",
        files: { [OBJECTIONS]: "# Objections\n- No SSO.\n" },
      },
      draft: { name: PLAYBOOK.name, files: UPDATE_ARGS.files },
    }
  );
  assert.deepEqual(calls.check, [{ kind: "update", update: card.draft }]);
  assert.deepEqual(calls.reads, [
    { name: PLAYBOOK.name, withFiles: true },
    { name: PLAYBOOK.name, file: OBJECTIONS },
  ]);
  assert.deepEqual(calls.apply, [], "nothing changes before Update skill");

  await approvals.saveSkillApproval(key);
  assert.deepEqual(calls.apply, [card.draft]);
  assert.equal(
    (await result).data,
    "Updated the enterprise-call-playbook skill. Tell the user it's updated and how it's used."
  );
});

test("a change naming ./References/Objections.md diffs against the file it replaces", async (t) => {
  const { update, entry, settled } = await setupUpdate(t);
  const content = "# Objections\n- SSO: Enterprise plan.\n";

  const files = [{ path: "./References/Objections.md", content }];
  const { key } = update({ ...UPDATE_ARGS, files });
  await settled();

  const card = entry(key);
  assert.deepEqual(card.draft.files, [{ path: OBJECTIONS, content }], "the file keeps its path");
  assert.deepEqual(card.current.files, { [OBJECTIONS]: "# Objections\n- No SSO.\n" });
});

test("a missing note just leaves out Learned from", async (t) => {
  const electron = updateElectron({ note: null });
  const { update, entry, settled, approvals } = await setupUpdate(t, electron);

  const { key } = update();
  await settled();

  assert.equal(entry(key).learnedFrom, null);
  approvals.skipSkillApproval(key);
});

// A small model can send a field's own hint as its value.
test("an update field that repeats its hint counts as unchanged", async (t) => {
  const { update, entry, settled } = await setupUpdate(t);
  const instructions = "## Steps\nAsk about budget.\nAsk about pricing.";

  const echoed = { ...UPDATE_ARGS, files: [], description: "The new description, if it changes" };
  const { key } = update({ ...echoed, instructions });
  await settled();

  assert.deepEqual(entry(key).draft, { name: PLAYBOOK.name, instructions, files: [] });
});

test("an update whose every field repeats its hint shows no card", async (t) => {
  const { update, entry, settled } = await setupUpdate(t);
  const args = {
    ...UPDATE_ARGS,
    files: [],
    description: "The new description, if it changes",
    instructions: "The full new instructions, if they change",
  };

  const { result, key } = update(args, "update-echo");
  await settled();

  assert.equal(entry(key), undefined);
  assert.match((await result).data, /the skill's new text/);
});

test("a proposal that repeats its hints is checked as empty, so it never shows", async (t) => {
  const electron = fakeElectron({ problems: [{ code: "missingDescription" }] });
  const { propose, calls } = await setup(t, electron);
  const echoed = {
    ...ARGS,
    description: "What the skill does and when to use it, in one or two sentences",
    instructions: "The skill's instructions, as short headed sections",
  };

  await propose(echoed).result;

  assert.equal(calls.check[0].proposal.description, "");
  assert.equal(calls.check[0].proposal.instructions, "");
});
