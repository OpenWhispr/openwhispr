const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const fakeClipboard = {
  text: "",
  html: "",
  formats: ["text/plain"],
  availableFormats() {
    return this.formats;
  },
  readText() {
    return this.text;
  },
  writeText(text) {
    this.text = text;
  },
  readHTML() {
    return this.html;
  },
  write(payload) {
    this.text = payload.text;
    this.html = payload.html;
  },
  readImage() {
    return { isEmpty: () => true };
  },
  writeImage() {},
};

const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
  if (request === "electron") {
    return {
      clipboard: fakeClipboard,
      systemPreferences: {
        isTrustedAccessibilityClient: () => true,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const ClipboardManager = require("../../src/helpers/clipboard");
Module._load = originalLoad;

function resetClipboard() {
  fakeClipboard.text = "";
  fakeClipboard.html = "";
  fakeClipboard.formats = ["text/plain"];
}

test("restore runs when clipboard still contains the pasted text", async () => {
  resetClipboard();
  fakeClipboard.text = "dictated text";
  const manager = new ClipboardManager();

  await manager._restoreClipboardAfterDelay(
    { type: "text", data: "previous clipboard" },
    { delayMs: 0, expectedText: "dictated text" }
  );

  assert.equal(fakeClipboard.text, "previous clipboard");
});

test("restore is skipped when another clipboard write wins the race", async () => {
  resetClipboard();
  fakeClipboard.text = "user copied something else";
  const manager = new ClipboardManager();

  await manager._restoreClipboardAfterDelay(
    { type: "text", data: "previous clipboard" },
    { delayMs: 0, expectedText: "dictated text" }
  );

  assert.equal(fakeClipboard.text, "user copied something else");
});

test("pasteText waits for prior clipboard restoration before starting the next paste", async () => {
  const manager = new ClipboardManager();
  const events = [];
  let releaseFirstRestore;

  manager._pasteText = async (text) => {
    events.push(`start:${text}`);
    events.push(`end:${text}`);
    if (text === "first") {
      return {
        restoreComplete: new Promise((resolve) => {
          releaseFirstRestore = resolve;
        }),
      };
    }
    return { restoreComplete: Promise.resolve() };
  };

  await manager.pasteText("first");
  const secondPaste = manager.pasteText("second");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events, ["start:first", "end:first"]);

  releaseFirstRestore();
  await secondPaste;
  assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second"]);
});
