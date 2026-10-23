const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { findElement } = require("../lib/interactiveDom");
const {
  ariaLabel,
  click,
  dispatch,
  findAll,
  label,
  mountSkillsComponent,
  settle,
  skill,
} = require("../lib/skillsHarness");

const MAX_BYTES = 25 * 1024 * 1024;

function fakeFile(name, { size = 4, text = "---" } = {}) {
  const file = {
    name,
    size,
    reads: 0,
    arrayBuffer: async () => {
      file.reads += 1;
      return new TextEncoder().encode(text).buffer;
    },
  };
  return file;
}

const ready = (fileName, name, warnings = []) => ({
  fileName,
  status: "ready",
  token: `token-${name}`,
  name,
  displayName: name,
  problems: [],
  warnings,
});
const duplicate = (fileName, name) => ({ ...ready(fileName, name), status: "duplicate" });
const invalid = (fileName, code) => ({
  fileName,
  status: "invalid",
  problems: [{ code }],
  warnings: [],
});

// previewQueue answers each preview call in turn, for screens that take several drops.
async function renderUpload(
  t,
  {
    previews = [],
    previewQueue = null,
    commit = null,
    previewFails = false,
    previewAnswered = null,
    skills = [],
    api = {},
  } = {}
) {
  const calls = { previewed: [], committed: [], discarded: [], done: [], back: 0 };
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/skills/UploadSkillsScreen.tsx",
    exportName: "UploadSkillsScreen",
    props: { onDone: (installed) => calls.done.push(installed), onBack: () => calls.back++ },
    skills,
    api: {
      skillsPreviewUpload: async (items) => {
        calls.previewed.push(items);
        if (previewFails) throw new Error("Error invoking remote method 'skills-preview-upload'");
        await previewAnswered;
        return { items: previewQueue ? previewQueue.shift() : previews.slice(0, items.length) };
      },
      skillsCommitUpload: async (request) => {
        calls.committed.push(request);
        return commit ?? { installed: request.replace.concat(["ready-one"]), failed: [] };
      },
      skillsDiscardUploads: async (tokens) => {
        calls.discarded.push(tokens);
        return { ok: true };
      },
      ...api,
    },
  });
  const { container } = mounted;
  const zone = findElement(container, (node) => node.getAttribute("role") === "button");
  const drop = async (...files) => {
    await React.act(async () => dispatch(zone, "drop", { dataTransfer: { files } }));
    await settle();
  };
  return { ...mounted, calls, drop };
}

const rows = (container) => findAll(container, (node) => node.getAttribute("role") === "listitem");
const button = (root, text) =>
  findElement(root, (node) => node.tagName === "BUTTON" && label(node) === text);
const submit = (container) =>
  findElement(
    container,
    (node) => node.tagName === "BUTTON" && label(node).startsWith("skills.upload.submit")
  );
const removeButton = (container, path) =>
  findElement(container, (node) => ariaLabel(node) === `skills.create.removeFile{"path":"${path}"}`);
const second = (preview) => ({ ...preview, token: `${preview.token}-2` });

test("ready, invalid and duplicate files each get their row and reason", async (t) => {
  const { container, calls, drop } = await renderUpload(t, {
    skills: [skill("follow-up")],
    previews: [
      ready("meeting-prep.skill", "meeting-prep", [{ code: "folderRenamed" }]),
      invalid("notes.md", "frontmatterMissing"),
      duplicate("follow-up.zip", "follow-up"),
    ],
  });

  await drop(fakeFile("meeting-prep.skill"), fakeFile("notes.md"), fakeFile("follow-up.zip"));

  assert.deepEqual(
    calls.previewed[0].map((item) => [item.fileName, item.data instanceof Uint8Array]),
    [
      ["meeting-prep.skill", true],
      ["notes.md", true],
      ["follow-up.zip", true],
    ]
  );
  assert.match(label(container), /skills\.upload\.fileCount\{"count":3\}/);
  const [first, second, third] = rows(container);
  assert.match(label(first), /^meeting-prep\.skill\s*skills\.upload\.ready/);
  assert.match(label(first), /skills\.warnings\.folderRenamed/);
  assert.match(label(second), /^notes\.md\s*skills\.problems\.frontmatterMissing$/);
  assert.match(label(third), /skills\.upload\.duplicate/);
  assert.ok(button(third, "skills.upload.replace"));
  assert.ok(button(third, "common.skip"));
  const fileName = findElement(
    first,
    (node) => node.tagName === "SPAN" && label(node) === "meeting-prep.skill"
  );
  assert.equal(fileName.getAttribute("dir"), "ltr");
});

test("a folder or an unreadable file gets its own row, and the rest still preview", async (t) => {
  const { container, calls, drop } = await renderUpload(t, { previews: [ready("a.md", "a")] });
  // A dropped folder arrives as a File whose read rejects.
  const unreadable = (name) => ({
    name,
    size: 96,
    arrayBuffer: async () => {
      throw new Error("NotFoundError");
    },
  });

  await drop(unreadable("my-skill"), fakeFile("a.md"), unreadable("b.md"));

  const [folder, readable, broken] = rows(container);
  assert.match(label(folder), /^my-skill\s*skills\.problems\.unsupportedFile$/);
  assert.match(label(readable), /^a\.md\s*skills\.upload\.ready/);
  assert.match(label(broken), /^b\.md\s*skills\.problems\.unreadableArchive$/);
  assert.deepEqual(
    calls.previewed.map((items) => items.map((item) => item.fileName)),
    [["a.md"]]
  );
});

test("a failed preview still lists every dropped file as one that can't be opened", async (t) => {
  const { container, drop } = await renderUpload(t, { previewFails: true });

  await drop(fakeFile("first.md"), fakeFile("second.zip"));

  const [first, second] = rows(container);
  assert.match(label(first), /^first\.md\s*skills\.problems\.unreadableArchive$/);
  assert.match(label(second), /^second\.zip\s*skills\.problems\.unreadableArchive$/);
});

test("leaving the screen frees the uploads it previewed", async (t) => {
  const { calls, drop, unmount } = await renderUpload(t, {
    previews: [ready("a.md", "a"), duplicate("b.zip", "b")],
  });
  await drop(fakeFile("a.md"), fakeFile("b.zip"));

  await unmount();

  assert.deepEqual(calls.discarded, [["token-a", "token-b"]]);
});

test("uploads previewed after the screen closed are let go too", async (t) => {
  let answer;
  const previewAnswered = new Promise((resolve) => (answer = resolve));
  const { calls, drop, unmount } = await renderUpload(t, {
    previews: [ready("late.zip", "late")],
    previewAnswered,
  });
  await drop(fakeFile("late.zip"));

  await unmount();
  answer();
  await settle();

  assert.deepEqual(calls.discarded, [[], ["token-late"]]);
});

test("Upload can't be pressed again once it has saved", async (t) => {
  const { container, calls, drop } = await renderUpload(t, {
    previews: [ready("a.md", "ready-one")],
  });
  await drop(fakeFile("a.md"));

  await click(submit(container));
  await settle();
  await click(submit(container));
  await settle();

  assert.equal(calls.committed.length, 1);
});

test("Replace and Skip decide what a duplicate does, with Undo", async (t) => {
  const { container, drop } = await renderUpload(t, {
    skills: [skill("follow-up")],
    previews: [duplicate("follow-up.zip", "follow-up")],
  });
  await drop(fakeFile("follow-up.zip"));
  const row = () => rows(container)[0];

  await click(button(row(), "skills.upload.replace"));
  assert.match(label(row()), /skills\.upload\.willReplace/);
  await click(button(row(), "skills.upload.undo"));
  assert.match(label(row()), /skills\.upload\.duplicate/);

  await click(button(row(), "common.skip"));
  assert.match(label(row()), /skills\.upload\.skipped/);
  await click(button(row(), "skills.upload.undo"));
  assert.match(label(row()), /skills\.upload\.duplicate/);
});

test("Upload counts ready skills and replaced ones", async (t) => {
  const { container, calls, toasts, drop, pushes } = await renderUpload(t, {
    skills: [skill("dup-skill")],
    previews: [ready("a.md", "ready-one"), duplicate("b.zip", "dup-skill")],
  });
  assert.equal(label(submit(container)), "skills.upload.submit");
  assert.equal(submit(container).getAttribute("disabled"), "");
  const hint = findElement(container, (node) => label(node) === "skills.upload.chooseFile");
  assert.equal(submit(container).getAttribute("aria-describedby"), hint.getAttribute("id"));

  await drop(fakeFile("a.md"), fakeFile("b.zip"));
  assert.equal(label(submit(container)), 'skills.upload.submitCount{"count":1}');
  assert.equal(findElement(container, (node) => label(node) === "skills.upload.chooseFile"), null);
  await click(button(rows(container)[1], "skills.upload.replace"));
  assert.equal(label(submit(container)), 'skills.upload.submitCount{"count":2}');

  await click(submit(container));
  await settle();

  assert.deepEqual(calls.committed, [
    { tokens: ["token-ready-one", "token-dup-skill"], replace: ["dup-skill"] },
  ]);
  assert.deepEqual(calls.done, [["dup-skill", "ready-one"]]);
  assert.deepEqual(toasts, [{ title: 'skills.toasts.uploaded{"count":2}', variant: "success" }]);
  assert.deepEqual(pushes, ["syncSkillsNow"], "one backup for the whole upload");
});

test("a skill dropped again in a later drop asks Replace or Skip too", async (t) => {
  const { container, calls, drop } = await renderUpload(t, {
    previewQueue: [
      [ready("v1.md", "weekly")],
      [{ ...ready("v2.md", "weekly"), token: "token-weekly-2" }],
    ],
  });
  await drop(fakeFile("v1.md"));
  await drop(fakeFile("v2.md"));

  const [first, second] = rows(container);
  assert.match(label(first), /skills\.upload\.ready/);
  assert.match(label(second), /skills\.upload\.alsoInUpload/);
  await click(button(second, "skills.upload.replace"));
  await click(submit(container));
  await settle();

  assert.deepEqual(calls.committed, [
    { tokens: ["token-weekly", "token-weekly-2"], replace: ["weekly"] },
  ]);
});

test("a skill twice in one upload says so, and Upload counts it once", async (t) => {
  const { container, drop } = await renderUpload(t, {
    previews: [ready("v1.md", "weekly"), duplicate("v2.md", "weekly")],
  });
  await drop(fakeFile("v1.md"), fakeFile("v2.md"));

  const second = rows(container)[1];
  assert.match(label(second), /skills\.upload\.alsoInUpload/);
  assert.doesNotMatch(label(second), /skills\.upload\.duplicate/);
  await click(button(second, "skills.upload.replace"));

  assert.match(label(rows(container)[1]), /skills\.upload\.willReplaceCopy/);
  assert.equal(label(submit(container)), 'skills.upload.submitCount{"count":1}');
});

test("a skipped or undecided duplicate is left out of the upload", async (t) => {
  const { container, calls, drop } = await renderUpload(t, {
    skills: [skill("dup-skill")],
    previews: [ready("a.md", "ready-one"), duplicate("b.zip", "dup-skill")],
  });
  await drop(fakeFile("a.md"), fakeFile("b.zip"));
  await click(button(rows(container)[1], "common.skip"));

  await click(submit(container));
  await settle();

  assert.deepEqual(calls.committed, [{ tokens: ["token-ready-one"], replace: [] }]);
});

test("a row can be removed on its own, letting go of its upload", async (t) => {
  const { container, calls, drop } = await renderUpload(t, {
    previews: [
      ready("a.md", "first"),
      invalid("notes.md", "frontmatterMissing"),
      ready("c.md", "third"),
    ],
  });
  await drop(fakeFile("a.md"), fakeFile("notes.md"), fakeFile("c.md"));

  await click(removeButton(container, "a.md"));
  await click(removeButton(container, "notes.md"));

  assert.equal(rows(container).length, 1);
  assert.match(label(rows(container)[0]), /^c\.md/);
  assert.deepEqual(calls.discarded, [["token-first"]]);
  assert.equal(label(submit(container)), 'skills.upload.submitCount{"count":1}');
});

test("removing one of two files of a new skill leaves the other ready", async (t) => {
  const { container, calls, drop } = await renderUpload(t, {
    previews: [ready("v1.md", "weekly"), second(duplicate("v2.md", "weekly"))],
  });
  await drop(fakeFile("v1.md"), fakeFile("v2.md"));

  await click(removeButton(container, "v1.md"));

  assert.match(label(rows(container)[0]), /^v2\.md\s*skills\.upload\.ready/);
  assert.equal(label(submit(container)), 'skills.upload.submitCount{"count":1}');
  await click(submit(container));
  await settle();
  assert.deepEqual(calls.committed, [{ tokens: ["token-weekly-2"], replace: [] }]);
});

// Replace on a second copy meant "this file, not the other one", so it's asked again once the
// other one is gone.
test("a skill you already have asks Replace or Skip, whichever of its files is left", async (t) => {
  const { container, drop } = await renderUpload(t, {
    skills: [skill("weekly")],
    previews: [duplicate("v1.md", "weekly"), second(duplicate("v2.md", "weekly"))],
  });
  await drop(fakeFile("v1.md"), fakeFile("v2.md"));
  assert.match(label(rows(container)[0]), /skills\.upload\.duplicate/);
  assert.match(label(rows(container)[1]), /skills\.upload\.alsoInUpload/);
  await click(button(rows(container)[1], "skills.upload.replace"));

  await click(removeButton(container, "v1.md"));

  assert.match(label(rows(container)[0]), /^v2\.md\s*skills\.upload\.duplicate/);
  assert.ok(button(rows(container)[0], "skills.upload.replace"));
});

// macOS and Windows disks don't tell names apart by case, so there it's the same folder.
test("a skill whose folder differs only in case asks Replace or Skip", async (t) => {
  const { container, drop } = await renderUpload(t, {
    skills: [skill("Meeting-Notes", { valid: false, problem: { code: "nameFormat" } })],
    previews: [ready("meeting-notes.md", "meeting-notes")],
  });

  await drop(fakeFile("meeting-notes.md"));

  assert.match(label(rows(container)[0]), /^meeting-notes\.md\s*skills\.upload\.duplicate/);
  assert.ok(button(rows(container)[0], "skills.upload.replace"));
});

test("removing a row moves focus to the next row's remove button, then the drop zone", async (t) => {
  const { container, drop } = await renderUpload(t, {
    previews: [ready("a.md", "first"), ready("b.md", "second"), ready("c.md", "third")],
  });
  await drop(fakeFile("a.md"), fakeFile("b.md"), fakeFile("c.md"));
  const focused = () => container.ownerDocument.activeElement;

  await click(removeButton(container, "b.md"));
  assert.equal(focused() === removeButton(container, "c.md"), true);
  await click(removeButton(container, "c.md"));
  assert.equal(focused() === removeButton(container, "a.md"), true);
  await click(removeButton(container, "a.md"));
  assert.equal(focused()?.getAttribute("aria-label"), "skills.upload.drop");
});

test("files still being read when the screen closes aren't previewed", async (t) => {
  let finishReading;
  const reading = new Promise((resolve) => {
    finishReading = resolve;
  });
  const { calls, drop, unmount } = await renderUpload(t, { previews: [ready("a.md", "late")] });
  const slow = fakeFile("a.md");
  slow.arrayBuffer = async () => {
    await reading;
    return new TextEncoder().encode("---").buffer;
  };

  await drop(slow);
  await unmount();
  finishReading();
  await settle();

  assert.deepEqual(calls.previewed, []);
});

test("a file over 25 MB is refused before it is read", async (t) => {
  const { container, calls, drop } = await renderUpload(t, {
    previews: [ready("small.md", "small")],
  });
  const big = fakeFile("huge.zip", { size: MAX_BYTES + 1 });

  await drop(big, fakeFile("small.md"));

  assert.equal(big.reads, 0);
  assert.deepEqual(
    calls.previewed.map((items) => items.map((item) => item.fileName)),
    [["small.md"]]
  );
  const [first, second] = rows(container);
  assert.match(label(first), /^huge\.zip\s*skills\.problems\.tooLarge$/);
  assert.match(label(second), /skills\.upload\.ready/);
});

test("an invalid file doesn't stop the others", async (t) => {
  const { container, calls, drop } = await renderUpload(t, {
    previews: [invalid("bad.md", "missingDescription"), ready("good.md", "ready-one")],
  });
  await drop(fakeFile("bad.md"), fakeFile("good.md"));

  assert.equal(label(submit(container)), 'skills.upload.submitCount{"count":1}');
  await click(submit(container));
  await settle();

  assert.deepEqual(calls.committed, [{ tokens: ["token-ready-one"], replace: [] }]);
  assert.deepEqual(calls.done, [["ready-one"]]);
});

test("a write that fails says why and stays on the screen", async (t) => {
  const { container, calls, toasts, drop } = await renderUpload(t, {
    previews: [ready("a.md", "ready-one")],
    commit: { installed: [], failed: [{ fileName: "a.md", error: "noSpace" }] },
  });
  await drop(fakeFile("a.md"));

  await click(submit(container));
  await settle();

  assert.deepEqual(calls.done, []);
  assert.deepEqual(toasts, [
    { title: "a.md", description: "skills.toasts.writeFailedNoSpace", variant: "destructive" },
  ]);
});

test("every file that doesn't install gets its own toast, named", async (t) => {
  const { container, toasts, drop } = await renderUpload(t, {
    previews: [ready("a.md", "first"), ready("b.md", "second"), ready("c.md", "third")],
    commit: {
      installed: [],
      failed: [
        { fileName: "a.md", error: "permission" },
        { fileName: "b.md", error: "unknown" },
        { fileName: "", error: "unknown" },
      ],
    },
  });
  await drop(fakeFile("a.md"), fakeFile("b.md"), fakeFile("c.md"));

  await click(submit(container));
  await settle();

  assert.deepEqual(toasts, [
    { title: "a.md", description: "skills.toasts.writeFailedPermission", variant: "destructive" },
    { title: "b.md", description: "skills.toasts.writeFailed", variant: "destructive" },
    { title: "skills.toasts.writeFailed", variant: "destructive" },
  ]);
});

test("a skill that appeared before Upload was pressed says so, then asks Replace or Skip", async (t) => {
  const { container, calls, toasts, drop, pushes } = await renderUpload(t, {
    previews: [ready("a.md", "weekly")],
    commit: { installed: [], failed: [{ fileName: "a.md", error: "exists" }] },
    api: { skillsList: async () => ({ skills: calls.committed.length ? [skill("weekly")] : [] }) },
  });
  await drop(fakeFile("a.md"));

  await click(submit(container));
  await settle();

  assert.deepEqual(toasts, [
    { title: "a.md", description: "skills.upload.duplicate", variant: "destructive" },
  ]);
  assert.match(label(rows(container)[0]), /skills\.upload\.duplicate/);
  assert.equal(submit(container).getAttribute("disabled"), "");
  assert.deepEqual(pushes, [], "nothing installed, nothing to back up");
});

test("chosen files are previewed like dropped ones, and the input takes skill files", async (t) => {
  const { container, calls } = await renderUpload(t, { previews: [ready("a.md", "ready-one")] });
  const input = findElement(container, (node) => node.tagName === "INPUT");
  // React sets multiple as a property, not an attribute
  assert.deepEqual([input.getAttribute("accept"), input.multiple], [".md,.zip,.skill", true]);

  input.files = [fakeFile("a.md")];
  await React.act(async () => dispatch(input, "change"));
  await settle();

  assert.deepEqual(
    calls.previewed.map((items) => items.map((item) => item.fileName)),
    [["a.md"]]
  );
  assert.equal(rows(container).length, 1);
  assert.ok(findElement(container, (node) => ariaLabel(node) === "skills.breadcrumb.label"));
});
