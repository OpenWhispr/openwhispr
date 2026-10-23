const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { installElectronStub } = require("../harness/electronStub.js");

installElectronStub();
const { registerSkillsIpc } = require("../../../src/helpers/skills/skillsIpc");
const debugLogger = require("../../../src/helpers/debugLogger");

const INVALID = { ok: false, error: "invalid" };
const SUMMARY = { name: "meeting-prep", enabled: true, valid: true };

function fakeLibrary(overrides = {}) {
  const calls = [];
  const record =
    (method, result) =>
    (...args) => {
      calls.push([method, ...args]);
      return typeof result === "function" ? result(...args) : result;
    };
  return {
    calls,
    scan: record("scan", [SUMMARY]),
    get: record("get", { ...SUMMARY, markdown: "x", files: [] }),
    readFile: record("readFile", "notes"),
    setEnabled: record("setEnabled", true),
    uninstall: record("uninstall"),
    skillDir: record("skillDir", (name) =>
      name === "meeting-prep" ? "/data/skills/meeting-prep" : null
    ),
    previewUploads: record("previewUploads", []),
    commitUploads: record("commitUploads", { installed: ["meeting-prep"], failed: [] }),
    discardUploads: record("discardUploads"),
    discardUploadsFrom: record("discardUploadsFrom"),
    create: record("create", { name: "weekly-recap" }),
    addRecommended: record("addRecommended", { name: "meeting-decisions" }),
    readForModel: record("readForModel", { name: "meeting-prep", body: "Steps", files: [] }),
    checkProposal: record("checkProposal", { name: "weekly-recap", existing: false, problems: [] }),
    saveProposal: record("saveProposal", { name: "weekly-recap", versionId: "1760950800000" }),
    markUsed: record("markUsed"),
    applyUpdate: record("applyUpdate", { name: "meeting-prep", versionId: "1760950800000" }),
    undo: record("undo", true),
    ...overrides,
  };
}

// A window's webContents: an id, and the events Electron sends when it goes away or reloads.
const fakeSender = (id = 1) => Object.assign(new EventEmitter(), { id });

function setup(libraryOverrides) {
  const handlers = new Map();
  const broadcasts = [];
  const revealed = [];
  const library = fakeLibrary(libraryOverrides);
  registerSkillsIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    library,
    shell: { showItemInFolder: (target) => revealed.push(target) },
    broadcast: (channel) => broadcasts.push(channel),
  });
  const callAs = (sender, channel, ...args) => handlers.get(channel)({ sender }, ...args);
  const call = (channel, ...args) => callAs(fakeSender(), channel, ...args);
  return { call, callAs, library, broadcasts, revealed };
}

const upload = (overrides = {}) => ({ fileName: "a.md", data: new Uint8Array([45]), ...overrides });
const draft = { title: "Recap", description: "Recaps.", instructions: "Go", files: [] };

test("a malformed name or upload item is refused before the library runs", async () => {
  const { call, library } = setup();

  for (const name of [7, "", "../escape", ".hidden", "a/b", null]) {
    assert.deepEqual(await call("skills-set-enabled", name, true), INVALID, String(name));
    assert.deepEqual(await call("skills-uninstall", name), INVALID, String(name));
    assert.equal(await call("skills-get", name), null, String(name));
    assert.equal(await call("skills-read-file", name, "SKILL.md"), null, String(name));
  }
  assert.deepEqual(await call("skills-set-enabled", "meeting-prep", "yes"), INVALID);
  assert.equal(await call("skills-read-file", "meeting-prep", 7), null);
  for (const items of [null, "a.md", [upload({ data: "text" })], [upload({ fileName: 7 })]]) {
    assert.deepEqual(await call("skills-preview-upload", items), INVALID);
  }
  for (const request of [null, { tokens: "t", replace: [] }, { tokens: [], replace: [3] }]) {
    assert.deepEqual(await call("skills-commit-upload", request), INVALID);
  }
  for (const input of [null, { ...draft, title: 3 }, { ...draft, files: [upload({ data: [] })] }]) {
    assert.deepEqual(await call("skills-create", input), INVALID);
  }
  assert.deepEqual(
    await call("skills-add-recommended", "meeting-decisions", { title: 1 }),
    INVALID
  );
  const copy = { title: "a", description: "b" };
  assert.deepEqual(await call("skills-add-recommended", "../x", copy), INVALID);

  assert.deepEqual(library.calls, []);
});

test("discarding uploads frees them without telling the windows", async () => {
  const { call, library, broadcasts } = setup();

  assert.deepEqual(await call("skills-discard-uploads", "token"), INVALID);
  assert.deepEqual(await call("skills-discard-uploads", ["a", "b"]), { ok: true });

  assert.deepEqual(library.calls, [["discardUploads", ["a", "b"]]]);
  assert.deepEqual(broadcasts, []);
});

test("a window that closes, crashes or reloads lets go of the uploads it previewed", async () => {
  const { callAs, library } = setup();
  const released = () => library.calls.filter(([method]) => method === "discardUploadsFrom");
  const panel = fakeSender(7);

  await callAs(panel, "skills-preview-upload", [upload()]);
  await callAs(panel, "skills-preview-upload", [upload()]);
  panel.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  panel.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  assert.deepEqual(released(), []);

  panel.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  panel.emit("render-process-gone", {}, { reason: "crashed" });
  panel.emit("destroyed");

  assert.deepEqual(
    library.calls.filter(([method]) => method === "previewUploads").map((entry) => entry[2]),
    [7, 7]
  );
  assert.deepEqual(released(), [
    ["discardUploadsFrom", 7],
    ["discardUploadsFrom", 7],
    ["discardUploadsFrom", 7],
  ]);
});

// The tokens are made once the files are read, after a window that went away meanwhile
// was told to let go.
test("uploads a window was still reading when it closed or reloaded are let go once read", async () => {
  const reload = { isMainFrame: true, isSameDocument: false };
  for (const [what, goAway, discarded] of [
    ["reload", (panel) => panel.emit("did-start-navigation", reload), [["late"]]],
    ["close", (panel) => panel.emit("destroyed"), [["late"]]],
    ["neither", () => {}, []],
  ]) {
    let finishReading;
    const reading = new Promise((resolve) => {
      finishReading = resolve;
    });
    const late = { fileName: "a.md", status: "ready", token: "late", problems: [], warnings: [] };
    const { callAs, library } = setup({
      previewUploads: async () => {
        await reading;
        return [late];
      },
    });
    const panel = fakeSender(7);

    const previewed = callAs(panel, "skills-preview-upload", [upload()]);
    goAway(panel);
    finishReading();

    assert.deepEqual(await previewed, { items: [late] }, what);
    const discards = library.calls.filter(([method]) => method === "discardUploads");
    assert.deepEqual(
      discards.map(([, tokens]) => tokens),
      discarded,
      what
    );
  }
});

test("every write broadcasts skills-changed", async () => {
  const { call, broadcasts } = setup();

  assert.deepEqual(await call("skills-list"), { skills: [SUMMARY] });
  await call("skills-get", "meeting-prep");
  assert.deepEqual(await call("skills-read-file", "meeting-prep", "notes.md"), { text: "notes" });
  assert.deepEqual(await call("skills-preview-upload", [upload()]), { items: [] });
  assert.deepEqual(broadcasts, [], "reads don't broadcast");

  assert.deepEqual(await call("skills-set-enabled", "meeting-prep", false), { ok: true });
  assert.deepEqual(await call("skills-uninstall", "meeting-prep"), { ok: true });
  assert.deepEqual(await call("skills-commit-upload", { tokens: ["t"], replace: [] }), {
    installed: ["meeting-prep"],
    failed: [],
  });
  assert.deepEqual(await call("skills-create", draft), { ok: true, name: "weekly-recap" });
  const copy = { title: "Meeting decisions", description: "Keeps decisions." };
  assert.deepEqual(await call("skills-add-recommended", "meeting-decisions", copy), {
    ok: true,
    name: "meeting-decisions",
  });
  assert.deepEqual(broadcasts, Array(5).fill("skills-changed"));
});

test("nothing written means nothing broadcast", async () => {
  const problems = [{ code: "placeholder" }];
  const { call, broadcasts } = setup({
    setEnabled: () => false,
    commitUploads: () => ({ installed: [], failed: [] }),
    create: () => ({ problems }),
    addRecommended: () => null,
  });

  assert.deepEqual(await call("skills-set-enabled", "meeting-prep", true), INVALID);
  await call("skills-commit-upload", { tokens: ["t"], replace: [] });
  assert.deepEqual(await call("skills-create", draft), { ok: false, problems });
  const copy = { title: "x", description: "y" };
  assert.deepEqual(await call("skills-add-recommended", "not-shipped", copy), INVALID);
  assert.deepEqual(broadcasts, []);
});

test("a write that fails reports why", async () => {
  const fail = (code) => () => {
    throw Object.assign(new Error("disk"), { code });
  };
  const { call, broadcasts } = setup({ uninstall: fail("permission"), create: fail("noSpace") });

  assert.deepEqual(await call("skills-uninstall", "meeting-prep"), {
    ok: false,
    error: "permission",
  });
  assert.deepEqual(await call("skills-create", draft), { ok: false, error: "noSpace" });
  assert.deepEqual(broadcasts, []);
});

test("a switch the database can't save is refused with a reason, not thrown", async () => {
  const { call, broadcasts } = setup({
    setEnabled: () => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    },
  });

  assert.deepEqual(await call("skills-set-enabled", "meeting-prep", true), {
    ok: false,
    error: "unknown",
  });
  assert.deepEqual(broadcasts, []);
});

test("reveal shows the skill's folder", async () => {
  const { call, revealed } = setup();

  assert.deepEqual(await call("skills-reveal", "meeting-prep"), { ok: true });
  assert.deepEqual(await call("skills-reveal", "missing"), { ok: false });
  assert.deepEqual(revealed, ["/data/skills/meeting-prep"]);
});

const proposal = { title: "Recap", description: "Recaps.", instructions: "Go", files: [] };

test("malformed model reads, proposals and marks never reach the library", async () => {
  const { call, library } = setup();

  for (const ref of [
    null,
    "meeting-prep",
    { name: 7 },
    { name: "../escape" },
    { name: "meeting-prep", builtin: "yes" },
    { name: "meeting-prep", file: 7 },
    { name: "meeting-prep", withFiles: 1 },
  ]) {
    assert.equal(await call("skills-read-for-model", ref), null, JSON.stringify(ref));
  }
  for (const bad of [
    null,
    { ...proposal, title: 7 },
    { ...proposal, files: "notes.md" },
    { ...proposal, files: [{ path: "a.md" }] },
    { ...proposal, files: [{ path: 7, content: "x" }] },
  ]) {
    const request = { kind: "create", proposal: bad };
    assert.deepEqual(await call("skills-check-proposal", request), INVALID);
    assert.deepEqual(await call("skills-save-proposal", bad), INVALID);
  }
  assert.deepEqual(await call("skills-check-proposal", { kind: "other", proposal }), INVALID);
  assert.equal(await call("skills-mark-used", "../escape"), undefined);
  assert.deepEqual(library.calls, []);
});

test("a saved proposal broadcasts skills-changed; reads, checks and marks don't", async () => {
  const { call, library, broadcasts } = setup();
  const ref = { name: "meeting-prep", file: "references/a.md" };

  assert.deepEqual(await call("skills-read-for-model", ref), {
    name: "meeting-prep",
    body: "Steps",
    files: [],
  });
  assert.deepEqual(await call("skills-check-proposal", { kind: "create", proposal }), {
    name: "weekly-recap",
    existing: false,
    problems: [],
  });
  await call("skills-mark-used", "meeting-prep");
  assert.deepEqual(broadcasts, []);

  assert.deepEqual(await call("skills-save-proposal", proposal), {
    ok: true,
    name: "weekly-recap",
    versionId: "1760950800000",
  });
  assert.deepEqual(broadcasts, ["skills-changed"]);
  assert.deepEqual(library.calls, [
    ["readForModel", ref],
    ["checkProposal", { kind: "create", proposal }],
    ["markUsed", "meeting-prep"],
    ["saveProposal", proposal],
  ]);
});

// A throw would reach the chat as Electron's error text, folder path and all.
test("the assistant's reads, checks and marks answer even when the library throws", async (t) => {
  const fail = () => {
    throw Object.assign(new Error("EACCES: permission denied, scandir '/data/skills'"), {
      code: "EACCES",
    });
  };
  const { call } = setup({ readForModel: fail, checkProposal: fail, markUsed: fail });
  const warn = t.mock.method(debugLogger, "warn", () => {});

  assert.equal(await call("skills-read-for-model", { name: "meeting-prep" }), null);
  assert.deepEqual(await call("skills-check-proposal", { kind: "create", proposal }), INVALID);
  assert.equal(await call("skills-mark-used", "meeting-prep"), undefined);
  // Each is logged, so a folder that can't be read still shows up in the logs.
  assert.equal(warn.mock.callCount(), 3);
});

test("a proposal that can't be saved reports why and broadcasts nothing", async () => {
  const problems = [{ code: "placeholder" }];
  const refused = setup({ saveProposal: () => ({ problems }) });
  assert.deepEqual(await refused.call("skills-save-proposal", proposal), { ok: false, problems });

  const full = setup({
    saveProposal: () => {
      throw Object.assign(new Error("disk"), { code: "noSpace" });
    },
  });
  assert.deepEqual(await full.call("skills-save-proposal", proposal), {
    ok: false,
    error: "noSpace",
  });
  assert.deepEqual([...refused.broadcasts, ...full.broadcasts], []);
});

test("a save from a card made before the skill changed is refused without a broadcast", async () => {
  const stale = setup({
    saveProposal: () => ({ changed: true }),
    applyUpdate: () => ({ changed: true }),
  });
  const update = { name: "meeting-prep", instructions: "New", files: [], baseHash: "a".repeat(64) };

  assert.deepEqual(await stale.call("skills-save-proposal", { ...proposal, baseHash: "b" }), {
    ok: false,
    error: "changed",
  });
  assert.deepEqual(await stale.call("skills-apply-update", update), {
    ok: false,
    error: "changed",
  });
  assert.deepEqual(await stale.call("skills-apply-update", { ...update, baseHash: 1 }), INVALID);
  assert.deepEqual(stale.broadcasts, []);
});

const update = { name: "meeting-prep", instructions: "New steps", files: [] };

test("updates and Undo are checked before the library runs", async () => {
  const { call, library } = setup();

  for (const bad of [
    null,
    { ...update, name: "../escape" },
    { ...update, description: 7 },
    { ...update, files: [{ path: "a.md", content: 7 }] },
  ]) {
    assert.deepEqual(await call("skills-apply-update", bad), INVALID, JSON.stringify(bad));
    assert.deepEqual(await call("skills-check-proposal", { kind: "update", update: bad }), INVALID);
  }
  for (const versionId of ["../1", "", 7, "12a"]) {
    assert.deepEqual(await call("skills-undo", "meeting-prep", versionId), INVALID);
  }
  assert.deepEqual(await call("skills-undo", "../escape", "1"), INVALID);
  assert.deepEqual(library.calls, []);
});

test("an applied update and its Undo broadcast; a missing version doesn't", async () => {
  const { call, broadcasts } = setup();
  assert.deepEqual(await call("skills-check-proposal", { kind: "update", update }), {
    name: "weekly-recap",
    existing: false,
    problems: [],
  });
  assert.deepEqual(broadcasts, []);

  assert.deepEqual(await call("skills-apply-update", update), {
    ok: true,
    name: "meeting-prep",
    versionId: "1760950800000",
  });
  assert.deepEqual(await call("skills-undo", "meeting-prep", "1760950800000"), { ok: true });
  assert.deepEqual(broadcasts, ["skills-changed", "skills-changed"]);

  const gone = setup({ undo: () => false, checkProposal: () => null });
  assert.deepEqual(await gone.call("skills-undo", "meeting-prep", "1"), INVALID);
  assert.deepEqual(await gone.call("skills-check-proposal", { kind: "update", update }), INVALID);
  assert.deepEqual(gone.broadcasts, []);
});

test("an update or Undo that fails to write reports why", async () => {
  const fail = (code) => () => {
    throw Object.assign(new Error("disk"), { code });
  };
  const { call, broadcasts } = setup({ applyUpdate: fail("noSpace"), undo: fail("permission") });

  assert.deepEqual(await call("skills-apply-update", update), { ok: false, error: "noSpace" });
  assert.deepEqual(await call("skills-undo", "meeting-prep", "1"), {
    ok: false,
    error: "permission",
  });
  assert.deepEqual(broadcasts, []);
});
