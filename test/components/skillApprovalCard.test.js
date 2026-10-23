const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const {
  SKILLS_MOCKS,
  ariaLabel,
  click,
  dispatch,
  findAll,
  label,
  settle,
  typeInto,
} = require("../lib/skillsHarness");

const PROPOSAL = {
  title: "Follow-up email from notes",
  description: "Drafts a follow-up email after a call, from that call's notes.",
  instructions: "## Steps\n1. Read the call's notes.",
  files: [],
};
const CREATE = { kind: "create", name: "follow-up-email-from-notes", draft: PROPOSAL };
const SAVED = { ok: true, name: "follow-up-email-from-notes" };

// The card on its store entry, as ToolCallItem shows it, with the skills IPC faked.
async function mountCard(
  t,
  { request = CREATE, saveResult = SAVED, undoResult = { ok: true }, openSkill, skills = [] } = {}
) {
  let root = null;
  let approvals = null;
  const key = "m1::call-1";
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  // A card left pending keeps its 10-minute expiry timer, and with it the process, alive.
  t.after(() => {
    if (approvals?.useSkillApprovalStore.getState().entries[key]?.state === "pending") {
      approvals.skipSkillApproval(key);
    }
  });
  const calls = { save: [], apply: [], undo: [] };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        skillsSaveProposal: async (proposal) => {
          calls.save.push(proposal);
          return saveResult;
        },
        skillsApplyUpdate: async (update) => {
          calls.apply.push(update);
          return { ok: true, name: update.name, versionId: "1760950800000" };
        },
        // A function answers each press in turn.
        skillsUndo: async (name, versionId) => {
          calls.undo.push([name, versionId]);
          return typeof undoResult === "function" ? undoResult() : undoResult;
        },
        // Where Save writes, as the card was told when it opened.
        skillsCheckProposal: async () => ({
          name: request.name,
          existing: Boolean(request.replacesExisting),
          problems: [],
        }),
      },
    },
  });
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-skill-approval-card-test-",
    noExternal: ["react-i18next"],
    mockModules: SKILLS_MOCKS,
  });
  approvals = await vite.ssrLoadModule("/stores/skillApprovalStore.ts");
  const skillsStore = await vite.ssrLoadModule("/stores/skillsStore.ts");
  skillsStore.useSkillsStore.setState({ skills, loaded: true });
  const { SkillApprovalCard } = await vite.ssrLoadModule("/components/chat/SkillApprovalCard.tsx");
  const { SkillChatActionsContext } = await vite.ssrLoadModule(
    "/components/chat/skillChatActions.ts"
  );
  approvals.useSkillApprovalStore.setState({ entries: {} });
  const outcome = approvals.requestSkillApproval(
    {
      messageId: "m1",
      toolCallId: "call-1",
      signal: new AbortController().signal,
      onApprovalRequested() {},
    },
    request
  );

  function Harness() {
    const entry = approvals.useSkillApprovalStore((state) => state.entries[key]);
    return entry ? React.createElement(SkillApprovalCard, { entry }) : null;
  }
  const card = React.createElement(Harness);
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      openSkill
        ? React.createElement(SkillChatActionsContext.Provider, { value: { openSkill } }, card)
        : card
    )
  );
  const buttonLabelled = (text) =>
    findAll(container, (node) => node.tagName === "BUTTON" && label(node) === text)[0];
  const fieldLabelled = (text) => findAll(container, (node) => ariaLabel(node) === text)[0];
  const cardElement = () =>
    findAll(container, (node) => node.getAttribute?.("data-approval-card") === key)[0];
  return { container, calls, outcome, approvals, key, buttonLabelled, fieldLabelled, cardElement };
}

test("the create card shows the title, description and Save skill / Edit / Skip", async (t) => {
  const { container, buttonLabelled } = await mountCard(t);

  const text = container.textContent;
  assert.match(text, /skills\.approval\.createHeader/);
  assert.match(text, /skills\.approval\.newSkill/);
  const title = findAll(container, (node) => label(node) === PROPOSAL.title)[0];
  const description = findAll(container, (node) => label(node) === PROPOSAL.description)[0];
  assert.deepEqual([title.getAttribute("dir"), description.getAttribute("dir")], ["auto", "auto"]);
  for (const name of ["skills.approval.save", "connectors.approval.edit", "common.skip"]) {
    assert.ok(buttonLabelled(name), name);
  }
});

test("See full skill shows the instructions", async (t) => {
  const { container, buttonLabelled } = await mountCard(t);
  const toggle = buttonLabelled("skills.approval.seeFull");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  await click(toggle);

  const instructions = findAll(container, (node) => node.tagName === "PRE")[0];
  assert.equal(instructions.textContent, PROPOSAL.instructions);
  assert.equal(instructions.getAttribute("dir"), "auto");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
});

test("See full skill also shows each file the skill would add", async (t) => {
  const style = { path: "references/style.md", content: "# Style\nShort sentences." };
  const request = { ...CREATE, draft: { ...PROPOSAL, files: [style] } };
  const { container, buttonLabelled } = await mountCard(t, { request });

  await click(buttonLabelled("skills.approval.seeFull"));

  const shown = findAll(container, (node) => node.tagName === "PRE").map((pre) => pre.textContent);
  assert.deepEqual(shown, [PROPOSAL.instructions, style.content]);
  const path = findAll(container, (node) => label(node) === style.path)[0];
  assert.equal(path?.getAttribute("dir"), "ltr", "the file's path is shown left to right");
});

test("Edit changes what Save writes", async (t) => {
  const { calls, buttonLabelled, fieldLabelled, outcome } = await mountCard(t);

  await click(buttonLabelled("connectors.approval.edit"));
  await typeInto(fieldLabelled("skills.approval.nameLabel"), "Call follow-up");
  await typeInto(fieldLabelled("skills.approval.descriptionLabel"), "After every call.");
  await click(buttonLabelled("skills.approval.save"));
  await settle();

  assert.deepEqual(calls.save, [
    { ...PROPOSAL, title: "Call follow-up", description: "After every call." },
  ]);
  assert.deepEqual(await outcome, { state: "saved", name: SAVED.name, edited: true });
});

test("Saved shows Open skill", async (t) => {
  const opened = [];
  const { container, buttonLabelled, cardElement } = await mountCard(t, {
    openSkill: (name) => opened.push(name),
  });

  await click(buttonLabelled("skills.approval.save"));
  await settle();

  assert.match(container.textContent, /skills\.approval\.saved/);
  assert.equal(globalThis.document.activeElement, cardElement(), "focus stays on the card");
  await click(buttonLabelled("skills.approval.openSkill"));
  assert.deepEqual(opened, ["follow-up-email-from-notes"]);
});

test("without a way to open skills, a saved card offers no Open skill", async (t) => {
  const { container, buttonLabelled } = await mountCard(t);

  await click(buttonLabelled("skills.approval.save"));
  await settle();

  assert.match(container.textContent, /skills\.approval\.saved/);
  assert.equal(buttonLabelled("skills.approval.openSkill"), undefined);
});

// The assistant only sees the skills that are on, so the one it names is one switched off.
test("a proposal over a skill that's switched off says saving turns it on", async (t) => {
  const off = {
    name: CREATE.name,
    displayName: PROPOSAL.title,
    description: PROPOSAL.description,
    enabled: false,
    valid: true,
    addedAt: null,
    updatedAt: null,
    lastUsedAt: null,
  };
  const { container } = await mountCard(t, {
    request: { ...CREATE, replacesExisting: true },
    skills: [off],
  });

  assert.match(container.textContent, /skills\.approval\.replacesExistingTurnsOn/);
});

test("a replacing save shows Updated with Undo", async (t) => {
  const { container, calls, buttonLabelled } = await mountCard(t, {
    request: { ...CREATE, replacesExisting: true },
    saveResult: { ...SAVED, versionId: "1760950800000" },
  });
  assert.match(container.textContent, /skills\.approval\.replacesExisting/);

  await click(buttonLabelled("skills.approval.save"));
  await settle();
  assert.match(container.textContent, /skills\.approval\.updated/);
  await click(buttonLabelled("skills.approval.undo"));
  await settle();

  assert.deepEqual(calls.undo, [["follow-up-email-from-notes", "1760950800000"]]);
  assert.match(container.textContent, /skills\.approval\.undone/);
  assert.equal(buttonLabelled("skills.approval.undo"), undefined);
});

test("an Undo the skill's later changes refuse says so and goes away", async (t) => {
  const { container, buttonLabelled } = await mountCard(t, {
    request: { ...CREATE, replacesExisting: true },
    saveResult: { ...SAVED, versionId: "1760950800000" },
    undoResult: { ok: false, error: "invalid" },
  });

  await click(buttonLabelled("skills.approval.save"));
  await settle();
  await click(buttonLabelled("skills.approval.undo"));
  await settle();

  assert.match(container.textContent, /skills\.approval\.undoStale/);
  assert.equal(buttonLabelled("skills.approval.undo"), undefined);
});

test("a refused save says why and leaves Save to try again", async (t) => {
  const { container, buttonLabelled } = await mountCard(t, {
    saveResult: { ok: false, problems: [{ code: "descriptionAngleBrackets" }] },
  });

  await click(buttonLabelled("skills.approval.save"));
  await settle();

  assert.match(container.textContent, /skills\.problems\.descriptionAngleBrackets/);
  assert.equal(Boolean(buttonLabelled("skills.approval.save")), true);
});

test("Skip leaves the card saying nothing was saved", async (t) => {
  const { container, calls, buttonLabelled, outcome } = await mountCard(t);

  await click(buttonLabelled("common.skip"));

  assert.deepEqual(await outcome, { state: "skipped" });
  assert.match(container.textContent, /skills\.approval\.skippedCreate/);
  assert.equal(buttonLabelled("skills.approval.save"), undefined);
  assert.deepEqual(calls.save, []);
});

test("Esc while editing stops editing and doesn't reach the panel", async (t) => {
  const { approvals, key, buttonLabelled, fieldLabelled } = await mountCard(t);
  await click(buttonLabelled("connectors.approval.edit"));
  const name = fieldLabelled("skills.approval.nameLabel");

  const event = { key: "Escape" };
  await React.act(async () =>
    dispatch(name, "keydown", {
      ...event,
      stopPropagation() {
        event.stopped = true;
        this.cancelBubble = true;
      },
    })
  );

  assert.equal(event.stopped, true);
  assert.equal(fieldLabelled("skills.approval.nameLabel"), undefined, "edit mode ended");
  assert.equal(approvals.useSkillApprovalStore.getState().entries[key].state, "pending");
});

test("an Esc that ends text composition keeps editing", async (t) => {
  const { buttonLabelled, fieldLabelled } = await mountCard(t);
  await click(buttonLabelled("connectors.approval.edit"));
  const name = fieldLabelled("skills.approval.nameLabel");

  await React.act(async () => dispatch(name, "keydown", { key: "Escape", isComposing: true }));

  assert.ok(fieldLabelled("skills.approval.nameLabel"), "still editing");
});

// ---- The Update card ----

const OBJECTIONS = "references/objections.md";
const UPDATE = {
  kind: "update",
  name: "enterprise-call-playbook",
  displayName: "Enterprise call playbook",
  intent: "Adds Acme's SSO pricing question to Objections, so the next call has the answer.",
  removals: [`the "we don't offer SSO" line`],
  learnedFrom: { title: "Call with Acme", createdAt: "2026-10-01 09:00:00" },
  current: {
    description: "Preps me for enterprise calls.",
    instructions: "## Steps\nAsk about budget.\n",
    files: { [OBJECTIONS]: "# Objections\n- We don't offer SSO.\n- Data: see the trust page.\n" },
  },
  draft: {
    name: "enterprise-call-playbook",
    files: [
      {
        path: OBJECTIONS,
        content: "# Objections\n- SSO: Enterprise plan.\n- Data: see the trust page.\n",
      },
    ],
  },
};

const diffRows = (container) =>
  findAll(container, (node) => typeof node.getAttribute?.("data-diff") === "string");

test(
  "the update card shows the intent, Removes, Learned from and the diff behind See exact changes",
  async (t) => {
    const { container, buttonLabelled } = await mountCard(t, { request: UPDATE });

    const text = container.textContent;
    for (const part of [
      "skills.approval.updateHeader",
      "Enterprise call playbook",
      UPDATE.intent,
      "skills.approval.removes",
      UPDATE.removals[0],
      'skills.approval.learnedFrom{"title":"Call with Acme","date":"Oct 1"}',
    ]) {
      assert.ok(text.includes(part), part);
    }
    assert.ok(!text.includes("SSO: Enterprise plan"), "the diff waits behind its toggle");
    for (const name of ["skills.approval.update", "connectors.approval.edit", "common.skip"]) {
      assert.ok(buttonLabelled(name), name);
    }

    await click(buttonLabelled("skills.approval.seeChanges"));

    assert.deepEqual(
      diffRows(container).map((row) => [row.getAttribute("data-diff"), label(row)]),
      [
        [" ", "# Objections"],
        ["-", "-skills.approval.removed- We don't offer SSO."],
        ["+", "+skills.approval.added- SSO: Enterprise plan."],
        [" ", "- Data: see the trust page."],
      ]
    );
    const diffPart = (node) => node.getAttribute?.("data-diff-part") === OBJECTIONS;
    const diff = findAll(container, diffPart)[0];
    assert.equal(diff.getAttribute("dir"), "ltr");
    assert.match(label(diff), /^references\/objections\.md/);
  }
);

test("a note from today reads Learned from … · Today", async (t) => {
  const today = new Date().toISOString().replace("T", " ").slice(0, 19);
  const { container } = await mountCard(t, {
    request: { ...UPDATE, learnedFrom: { title: "Call with Acme", createdAt: today } },
  });

  assert.ok(
    container.textContent.includes(
      'skills.approval.learnedFrom{"title":"Call with Acme","date":"skills.approval.today"}'
    )
  );
});

test("Edit changes the text Update skill writes", async (t) => {
  const { calls, buttonLabelled, fieldLabelled, outcome } = await mountCard(t, {
    request: UPDATE,
  });

  await click(buttonLabelled("connectors.approval.edit"));
  await typeInto(fieldLabelled(OBJECTIONS), "# Objections\n- SSO: ask sales.\n");
  await click(buttonLabelled("skills.approval.update"));
  await settle();

  assert.deepEqual(calls.apply, [
    {
      ...UPDATE.draft,
      files: [{ path: OBJECTIONS, content: "# Objections\n- SSO: ask sales.\n" }],
    },
  ]);
  assert.deepEqual(await outcome, { state: "saved", name: UPDATE.name, edited: true });
});

test("Undo restores the previous version and says so", async (t) => {
  const { container, calls, buttonLabelled } = await mountCard(t, { request: UPDATE });

  await click(buttonLabelled("skills.approval.update"));
  await settle();
  assert.match(container.textContent, /skills\.approval\.updated/);
  await click(buttonLabelled("skills.approval.undo"));
  await settle();

  assert.deepEqual(calls.undo, [[UPDATE.name, "1760950800000"]]);
  assert.match(container.textContent, /skills\.approval\.undone/);
});

// Main refuses a second Undo of the same save, so pressing twice would end on "changed since".
test("a second Undo press while one runs undoes once", async (t) => {
  let finish;
  const answers = [
    new Promise((resolve) => {
      finish = () => resolve({ ok: true });
    }),
    { ok: false, error: "invalid" },
  ];
  const { container, calls, buttonLabelled } = await mountCard(t, {
    request: UPDATE,
    undoResult: () => answers.shift(),
  });
  await click(buttonLabelled("skills.approval.update"));
  await settle();

  await click(buttonLabelled("skills.approval.undo"));
  await click(buttonLabelled("skills.approval.undo"));
  finish();
  await settle();

  assert.equal(calls.undo.length, 1);
  assert.match(container.textContent, /skills\.approval\.undone/);
});

async function undoThatFails(t, undoResult) {
  const { container, buttonLabelled } = await mountCard(t, { request: UPDATE, undoResult });
  await click(buttonLabelled("skills.approval.update"));
  await settle();

  await click(buttonLabelled("skills.approval.undo"));
  await settle();

  assert.match(container.textContent, /skills\.approval\.undoFailed/);
  assert.doesNotMatch(container.textContent, /skills\.approval\.undoStale/);
  assert.ok(buttonLabelled("skills.approval.undo"), "Undo is offered again");
}

test("an Undo that can't be written says so and can be tried again", async (t) => {
  await undoThatFails(t, { ok: false, error: "noSpace" });
});

test("an Undo whose request fails says so and can be tried again", async (t) => {
  await undoThatFails(t, () => Promise.reject(new Error("Error invoking remote method")));
});

// The card sits in a narrow panel, where a line that doesn't wrap scrolls sideways.
test("the update card's editors wrap their lines", async (t) => {
  const instructions = "## Steps\nAsk about budget and SSO.\n";
  const { buttonLabelled, fieldLabelled } = await mountCard(t, {
    request: { ...UPDATE, draft: { ...UPDATE.draft, instructions } },
  });

  await click(buttonLabelled("connectors.approval.edit"));

  for (const field of ["SKILL.md", OBJECTIONS]) {
    assert.equal(fieldLabelled(field).tagName, "TEXTAREA", field);
    assert.notEqual(fieldLabelled(field).getAttribute("wrap"), "off", field);
    // Instructions and code, not prose to correct. React writes the attribute as spellCheck,
    // which a real DOM folds to lowercase.
    assert.equal(fieldLabelled(field).getAttribute("spellCheck"), "false", field);
  }
});

// Cleared while the next one runs, so a second failure is shown and announced afresh.
test("an Undo tried again after it failed clears the failure while it runs", async (t) => {
  let finish;
  const answers = [
    { ok: false, error: "noSpace" },
    new Promise((resolve) => {
      finish = () => resolve({ ok: false, error: "noSpace" });
    }),
  ];
  const { container, buttonLabelled } = await mountCard(t, {
    request: UPDATE,
    undoResult: () => answers.shift(),
  });
  await click(buttonLabelled("skills.approval.update"));
  await settle();
  await click(buttonLabelled("skills.approval.undo"));
  await settle();
  assert.match(container.textContent, /skills\.approval\.undoFailed/);

  await click(buttonLabelled("skills.approval.undo"));
  assert.doesNotMatch(container.textContent, /skills\.approval\.undoFailed/);
  finish();
  await settle();

  assert.match(container.textContent, /skills\.approval\.undoFailed/);
});
