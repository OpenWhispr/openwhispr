const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { findElement } = require("../lib/interactiveDom");
const {
  click,
  dispatch,
  findAll,
  label,
  mountSkillsComponent,
  pressEscape,
  settle,
  typeInto,
} = require("../lib/skillsHarness");

async function renderCreate(t, { api = {}, draft = null } = {}) {
  const calls = { created: [], back: 0, saved: [] };
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/skills/CreateSkillScreen.tsx",
    exportName: "CreateSkillScreen",
    props: {
      onCreated: (name) => calls.created.push(name),
      onBack: () => calls.back++,
    },
    api: {
      skillsCreate: async (input) => {
        calls.saved.push(input);
        return { ok: true, name: "weekly-status-report" };
      },
      ...api,
    },
  });
  if (draft) {
    await React.act(async () => mounted.store.setCreateDraft(draft));
  }
  return { ...mounted, calls };
}

const byId = (container, id) => findElement(container, (node) => node.getAttribute("id") === id);
// Each control is found through its <label for>, which also checks they're tied together.
const FIELD_LABELS = {
  name: "skills.create.name",
  description: "skills.create.descriptionLabel",
  instructions: "skills.create.instructions",
};
const field = (container, key) => {
  const fieldLabel = findElement(
    container,
    (node) => node.tagName === "LABEL" && label(node) === FIELD_LABELS[key]
  );
  return byId(container, fieldLabel.getAttribute("for"));
};
const messageFor = (container, key) =>
  label(byId(container, field(container, key).getAttribute("aria-describedby")));
const button = (container, text) =>
  findElement(container, (node) => node.tagName === "BUTTON" && label(node) === text);
const createButton = (container) => button(container, "skills.create.submit");
const alert = (container) =>
  findElement(container, (node) => node.getAttribute("role") === "alert");
const focused = (container) => container.ownerDocument.activeElement;

const MB = 1024 * 1024;
// React sets an input's type as a property
const fileInput = (container) =>
  findElement(container, (node) => node.tagName === "INPUT" && node.type === "file");
const fakeFile = (name, bytes) => ({
  name,
  size: bytes.length,
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});
async function pick(container, files) {
  const input = fileInput(container);
  input.files = files;
  await React.act(async () => dispatch(input, "change"));
  await settle();
}
// The file chips' list, not the breadcrumb's
const chips = (container) =>
  findAll(container, (node) => node.tagName === "LI" && node.parentNode.tagName === "UL");

async function fill(container, { name = "", description = "", instructions = "" }) {
  if (name) await typeInto(field(container, "name"), name);
  if (description) await typeInto(field(container, "description"), description);
  if (instructions) await typeInto(field(container, "instructions"), instructions);
}

test(
  "Create stays dimmed until every field is filled, and still explains why on press",
  async (t) => {
    const { container, calls } = await renderCreate(t);
    assert.equal(createButton(container).getAttribute("aria-disabled"), "true");
    assert.equal(createButton(container).getAttribute("disabled"), null);

    await fill(container, { name: "Weekly status report", description: "Writes my update." });
    assert.equal(createButton(container).getAttribute("aria-disabled"), "true");
    await click(createButton(container));
    assert.match(label(container), /skills\.create\.instructionsMissing/);
    assert.deepEqual(calls.saved, []);

    await fill(container, { instructions: "## Steps\n1. Read notes." });
    assert.equal(createButton(container).getAttribute("aria-disabled"), "false");
  }
);

test(
  "pressing Create with gaps shows each message under its field and focuses the first",
  async (t) => {
    const { container } = await renderCreate(t);
    await fill(container, { description: "Writes my update." });

    await click(createButton(container));

    const name = field(container, "name");
    assert.equal(focused(container) === name, true);
    assert.equal(name.getAttribute("aria-invalid"), "true");
    assert.equal(field(container, "instructions").getAttribute("aria-invalid"), "true");
    assert.equal(messageFor(container, "name"), "skills.create.nameMissing");
    assert.equal(messageFor(container, "instructions"), "skills.create.instructionsMissing");
    assert.equal(field(container, "description").getAttribute("aria-invalid"), null);

    // Fixing a field clears its message
    await typeInto(name, "Weekly status report");
    assert.equal(name.getAttribute("aria-invalid"), null);
    assert.doesNotMatch(label(container), /skills\.create\.nameMissing/);
  }
);

test("a filled form creates the skill, clears the draft and toasts", async (t) => {
  const { container, calls, toasts, store } = await renderCreate(t);
  await fill(container, {
    name: "Weekly status report",
    description: "Writes my update.",
    instructions: "## Steps",
  });

  await click(createButton(container));
  await settle();

  assert.deepEqual(calls.saved, [
    {
      title: "Weekly status report",
      description: "Writes my update.",
      instructions: "## Steps",
      files: [],
    },
  ]);
  assert.deepEqual(calls.created, ["weekly-status-report"]);
  assert.equal(store.useSkillsStore.getState().createDraft, null);
  assert.deepEqual(toasts, [
    { title: 'skills.toasts.created{"name":"Weekly status report"}', variant: "success" },
  ]);
});

test(
  "leaving with unsaved text shows the bar; Keep editing stays and Discard leaves",
  async (t) => {
    const { container, calls, store } = await renderCreate(t);
    await click(button(container, "common.cancel"));
    assert.equal(calls.back, 1, "an empty form leaves at once");

    await fill(container, { name: "Half done" });
    await click(button(container, "common.cancel"));
    assert.equal(
      label(alert(container)),
      "skills.create.unsavedskills.create.keepEditingskills.create.discard"
    );
    assert.equal(calls.back, 1);

    await click(button(container, "skills.create.keepEditing"));
    assert.equal(alert(container), null);
    assert.equal(focused(container) === field(container, "name"), true);

    await click(button(container, "skills.breadcrumb.root"));
    assert.ok(alert(container));
    await click(button(container, "skills.create.discard"));
    assert.equal(calls.back, 2);
    assert.equal(store.useSkillsStore.getState().createDraft, null);
  }
);

test("Esc with unsaved text shows the bar, and Esc again dismisses it", async (t) => {
  const { container, calls } = await renderCreate(t);
  await fill(container, { name: "Half done" });
  const name = field(container, "name");

  await pressEscape(name);
  assert.ok(alert(container));
  await pressEscape(name);
  assert.equal(alert(container), null);
  assert.equal(calls.back, 0);
});

test("a file that can't be read is refused by name, and the others are added", async (t) => {
  const { container, toasts } = await renderCreate(t);
  const moved = {
    name: "moved-away.md",
    size: 3,
    arrayBuffer: async () => {
      throw new Error("NotReadableError");
    },
  };

  await pick(container, [fakeFile("kept.md", [1, 2]), moved]);

  assert.equal(chips(container).length, 1);
  assert.match(label(chips(container)[0]), /kept\.md/);
  assert.deepEqual(toasts, [
    {
      title: "moved-away.md",
      description: "skills.problems.unreadableArchive",
      variant: "destructive",
    },
  ]);
});

test("a file still being read when the draft is discarded doesn't bring it back", async (t) => {
  let finishRead;
  const slow = {
    name: "big.md",
    size: 3,
    arrayBuffer: () =>
      new Promise((resolve) => {
        finishRead = () => resolve(new Uint8Array([1]).buffer);
      }),
  };
  const { container, store } = await renderCreate(t);
  await fill(container, { name: "Half done" });
  await pick(container, [slow]);
  await click(button(container, "common.cancel"));
  await click(button(container, "skills.create.discard"));

  await React.act(async () => finishRead());
  await settle();

  assert.equal(store.useSkillsStore.getState().createDraft, null);
});

const slowFile = (name) => {
  const file = { name, size: 3 };
  file.arrayBuffer = () =>
    new Promise((resolve) => {
      file.finishRead = () => resolve(new Uint8Array([1]).buffer);
    });
  return file;
};

test("a file still being read when an empty draft is left doesn't come back", async (t) => {
  const { container, store, unmount } = await renderCreate(t);
  const slow = slowFile("late.md");
  await pick(container, [slow]);
  await click(button(container, "common.cancel"));
  await unmount();

  await React.act(async () => slow.finishRead());
  await settle();

  assert.equal(store.useSkillsStore.getState().createDraft?.files.length ?? 0, 0);
});

// A half-written draft is kept when the screen is left, and so is a file still being read for it.
test("a file still being read when a draft with text is left lands in that draft", async (t) => {
  const { container, store, unmount } = await renderCreate(t);
  await fill(container, { name: "Half done" });
  const slow = slowFile("late.md");
  await pick(container, [slow]);
  await unmount();

  await React.act(async () => slow.finishRead());
  await settle();

  const draft = store.useSkillsStore.getState().createDraft;
  assert.deepEqual(
    [draft.title, draft.files.map((file) => file.fileName)],
    ["Half done", ["late.md"]]
  );
});

test("a file still being read when the skill is created doesn't join the next draft", async (t) => {
  const { container, store } = await renderCreate(t);
  await fill(container, { name: "Weekly", description: "Recaps.", instructions: "Go" });
  const slow = slowFile("late.md");
  await pick(container, [slow]);
  await click(createButton(container));
  await settle();

  await React.act(async () => slow.finishRead());
  await settle();

  assert.equal(store.useSkillsStore.getState().createDraft, null);
});

test("an Esc that ends text composition keeps editing", async (t) => {
  const { container, calls } = await renderCreate(t);
  await fill(container, { name: "Half done" });

  await React.act(async () =>
    dispatch(field(container, "name"), "keydown", { key: "Escape", isComposing: true })
  );

  assert.equal(alert(container), null);
  assert.equal(calls.back, 0);
});

test("the draft survives leaving the Integrations page", async (t) => {
  const { container } = await renderCreate(t, {
    draft: {
      title: "Weekly status report",
      description: "Writes my update.",
      instructions: "## Steps",
      files: [{ fileName: "example.md", data: new Uint8Array([1]) }],
    },
  });

  assert.equal(field(container, "name").value, "Weekly status report");
  assert.equal(field(container, "description").value, "Writes my update.");
  assert.equal(field(container, "instructions").value, "## Steps");
  assert.match(label(container), /example\.md/);
});

test("a problem from the library shows under the field it concerns", async (t) => {
  const responses = [
    { ok: false, problems: [{ code: "descriptionAngleBrackets" }] },
    { ok: false, problems: [{ code: "placeholder" }] },
    { ok: false, problems: [{ code: "nameTaken", values: { name: "Draft" } }] },
  ];
  const { container, calls } = await renderCreate(t, {
    api: { skillsCreate: async () => responses.shift() },
  });
  await fill(container, { name: "Draft", description: "Uses <b>", instructions: "[TODO: x]" });

  await click(createButton(container));
  await settle();
  assert.equal(messageFor(container, "description"), "skills.problems.descriptionAngleBrackets");

  await click(createButton(container));
  await settle();
  assert.equal(messageFor(container, "instructions"), "skills.problems.placeholder");

  await click(createButton(container));
  await settle();
  assert.equal(messageFor(container, "name"), 'skills.problems.nameTaken{"name":"Draft"}');
  assert.deepEqual(calls.created, []);
});

test("a problem with the attached files shows in a toast, named by the file", async (t) => {
  const responses = [
    { ok: false, problems: [{ code: "unsafePath", values: { path: "What to ask?.md" } }] },
    { ok: false, problems: [{ code: "tooLarge" }] },
  ];
  const { container, toasts, calls } = await renderCreate(t, {
    api: { skillsCreate: async () => responses.shift() },
  });
  await fill(container, { name: "Draft", description: "Does it.", instructions: "Go" });

  await click(createButton(container));
  await settle();
  await click(createButton(container));
  await settle();

  assert.deepEqual(toasts, [
    {
      title: "What to ask?.md",
      description: 'skills.problems.unsafePath{"path":"What to ask?.md"}',
      variant: "destructive",
    },
    {
      title: "skills.toasts.writeFailed",
      description: "skills.problems.tooLarge",
      variant: "destructive",
    },
  ]);
  for (const key of Object.keys(FIELD_LABELS)) {
    assert.equal(field(container, key).getAttribute("aria-invalid"), null);
  }
  assert.deepEqual(calls.created, []);
});

test("a write that fails says why", async (t) => {
  const { container, toasts, calls } = await renderCreate(t, {
    api: { skillsCreate: async () => ({ ok: false, error: "permission" }) },
  });
  await fill(container, { name: "Draft", description: "Does it.", instructions: "Go" });

  await click(createButton(container));
  await settle();

  assert.deepEqual(calls.created, []);
  assert.deepEqual(toasts, [
    {
      title: "skills.toasts.writeFailed",
      description: "skills.toasts.writeFailedPermission",
      variant: "destructive",
    },
  ]);
});

test("an added file appears as a chip and can be removed", async (t) => {
  const { container, calls } = await renderCreate(t);
  const addFile = () => pick(container, [fakeFile("export.sh", [1, 2, 3])]);

  await addFile();
  assert.equal(chips(container).length, 1);
  const fileName = findElement(chips(container)[0], (node) => node.tagName === "SPAN");
  assert.deepEqual([label(fileName), fileName.getAttribute("dir")], ["export.sh", "ltr"]);
  const remove = findElement(
    chips(container)[0],
    (node) => node.getAttribute("aria-label") === 'skills.create.removeFile{"path":"export.sh"}'
  );
  await click(remove);
  assert.equal(chips(container).length, 0);

  await addFile();
  await fill(container, { name: "Export", description: "Exports.", instructions: "Run it." });
  await click(createButton(container));
  await settle();
  assert.deepEqual(
    calls.saved[0].files.map((file) => [file.fileName, [...file.data]]),
    [["export.sh", [1, 2, 3]]]
  );
});

test("a file named like one already added replaces it", async (t) => {
  const { container, calls } = await renderCreate(t);
  await pick(container, [fakeFile("export.sh", [1])]);
  await pick(container, [fakeFile("Export.sh", [2])]);
  assert.equal(chips(container).length, 1);

  await fill(container, { name: "Export", description: "Exports.", instructions: "Run it." });
  await click(createButton(container));
  await settle();
  assert.deepEqual(
    calls.saved[0].files.map((file) => [file.fileName, [...file.data]]),
    [["Export.sh", [2]]]
  );
});

test("a file that would take the skill past 25 MB is refused before it is read", async (t) => {
  const { container, toasts } = await renderCreate(t);
  const read = [];
  const sized = (name, size) => ({
    name,
    size,
    arrayBuffer: async () => {
      read.push(name);
      return new Uint8Array(1).buffer;
    },
  });

  await pick(container, [sized("notes.pdf", 15 * MB), sized("video.mov", 15 * MB)]);

  assert.deepEqual(read, ["notes.pdf"]);
  assert.equal(chips(container).length, 1);
  assert.deepEqual(toasts, [
    { title: "video.mov", description: "skills.create.filesTooLarge", variant: "destructive" },
  ]);
});
