const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
let saveDialogOptions;
let saveDialogResult;
let note;

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }

    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {
    showSaveDialog: async (options) => {
      saveDialogOptions = options;
      return saveDialogResult;
    },
  },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (
    parent?.filename === handlersModulePath &&
    (request.startsWith("./") || request.startsWith("../"))
  ) {
    return anything();
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    databaseManager: {
      getNote: () => note,
    },
    _buildSpeakerMappings: () => ({}),
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.beforeEach(() => {
  saveDialogOptions = undefined;
  saveDialogResult = { canceled: true, filePath: "" };
  note = {
    id: 1,
    title: "Team sync",
    transcript: JSON.stringify([{ text: "Hello", start: 0, end: 1 }]),
  };
});

test.after(() => {
  Module._load = originalLoad;
});

test("Markdown transcript export limits the save dialog to Markdown files", async () => {
  const result = await handlers.get("export-transcript")({}, 1, "md");

  assert.deepEqual(saveDialogOptions, {
    defaultPath: "Team sync.md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  assert.deepEqual(result, { success: false });
});

for (const [format, name] of [
  ["md", "Markdown"],
  ["txt", "Text"],
]) {
  test(`${name} note export limits the save dialog to ${name} files`, async () => {
    const result = await handlers.get("export-note")({}, 1, format);

    assert.deepEqual(saveDialogOptions, {
      defaultPath: `Team sync.${format}`,
      filters: [{ name, extensions: [format] }],
    });
    assert.deepEqual(result, { success: false });
  });
}

async function exportNoteToFile(t, content, format = "txt") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-export-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, `note.${format}`);
  note.content = content;
  saveDialogResult = { canceled: false, filePath };
  assert.deepEqual(await handlers.get("export-note")({}, 1, format), { success: true });
  return fs.readFileSync(filePath, "utf8");
}

test("Text note export preserves literal identifiers, arithmetic and fenced code", async (t) => {
  const content = "File: report_final.csv\nCompute 2 * 3.\n```sh\nls ~/project_*\n```";
  assert.equal(
    await exportNoteToFile(t, content),
    "File: report_final.csv\nCompute 2 * 3.\nls ~/project_*"
  );
});

test("Text note export strips formatting while retaining paragraphs and list lines", async (t) => {
  const content = "# Plan\n\n**Ship** with _care_.\n> Keep this\n- First\n- Second";
  assert.equal(
    await exportNoteToFile(t, content),
    "Plan\n\nShip with care.\nKeep this\n- First\n- Second"
  );
});

test("Text note export keeps inline code and linked resource addresses", async (t) => {
  const content = "Run `a_b * c`.\nSee [the report](https://example.test/report_final?q=a_b).";
  assert.equal(
    await exportNoteToFile(t, content),
    "Run a_b * c.\nSee the report (https://example.test/report_final?q=a_b)."
  );
});

test("Text note export preserves code whitespace and accepts empty content", async (t) => {
  assert.equal(await exportNoteToFile(t, "```\n  value_name * 2  \n```"), "  value_name * 2  ");
  for (const content of ["", null, undefined]) {
    assert.equal(await exportNoteToFile(t, content), "");
  }
});

test("Text note export preserves literal pipes and hyphen-only table data", async (t) => {
  assert.equal(await exportNoteToFile(t, "|x|"), "|x|");
  assert.equal(
    await exportNoteToFile(t, "| Name | Value |\n| --- | --- |\n| - | - |\n| actual | 5 |"),
    "Name\tValue\n-\t-\nactual\t5"
  );
});

test("Text note export removes bold spanning an editor hard break", async (t) => {
  assert.equal(await exportNoteToFile(t, "**first\\\nsecond**"), "first\\\nsecond");
});

test("Markdown note export retains the existing enhanced-content preference", async (t) => {
  note.enhanced_content = "## Summary\n**Ready**";
  assert.equal(await exportNoteToFile(t, "Original notes", "md"), note.enhanced_content);
  note.enhanced_content = null;
  assert.equal(await exportNoteToFile(t, "**Original notes**", "md"), "**Original notes**");
});

test("a repeated Text note export writes the latest content to the selected file", async (t) => {
  await exportNoteToFile(t, "First_file");
  note.content = "Second_file";
  assert.deepEqual(await handlers.get("export-note")({}, 1, "txt"), { success: true });
  assert.equal(fs.readFileSync(saveDialogResult.filePath, "utf8"), "Second_file");
});

test("canceling a Text note export does not write the selected path", async (t) => {
  await exportNoteToFile(t, "Existing_file");
  saveDialogResult.canceled = true;
  note.content = "Replacement_file";
  assert.deepEqual(await handlers.get("export-note")({}, 1, "txt"), { success: false });
  assert.equal(fs.readFileSync(saveDialogResult.filePath, "utf8"), "Existing_file");
});

test("a failed Text note write returns an error and a later export still succeeds", async (t) => {
  await exportNoteToFile(t, "Initial_file");
  saveDialogResult.filePath = path.dirname(saveDialogResult.filePath);
  const result = await handlers.get("export-note")({}, 1, "txt");
  assert.equal(result.success, false);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0);
  assert.equal(await exportNoteToFile(t, "Retry_file"), "Retry_file");
});
