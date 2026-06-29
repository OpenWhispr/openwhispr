const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const fakeClipboard = {
  text: "",
  html: "",
  rtf: "",
  image: null,
  formats: ["text/plain"],
  writes: [],
  availableFormats() {
    return this.formats;
  },
  readText() {
    return this.text;
  },
  writeText(text) {
    this.text = text;
    this.html = "";
    this.rtf = "";
    this.image = null;
    this.formats = ["text/plain"];
    this.writes.push(["writeText", text]);
  },
  readHTML() {
    return this.html;
  },
  readRTF() {
    return this.rtf;
  },
  write(payload) {
    this.text = payload.text || "";
    this.html = payload.html || "";
    this.rtf = payload.rtf || "";
    this.image = payload.image || null;
    this.formats = [];
    if (Object.hasOwn(payload, "text")) this.formats.push("text/plain");
    if (Object.hasOwn(payload, "html")) this.formats.push("text/html");
    if (Object.hasOwn(payload, "rtf")) this.formats.push("text/rtf");
    if (Object.hasOwn(payload, "image")) this.formats.push("image/png");
    this.writes.push(["write", payload]);
  },
  readImage() {
    return this.image || emptyImage;
  },
  writeImage(image) {
    this.text = "";
    this.html = "";
    this.rtf = "";
    this.image = image;
    this.formats = image && !image.isEmpty() ? ["image/png"] : [];
    this.writes.push(["writeImage", image]);
  },
};

const emptyImage = { isEmpty: () => true };
const nonEmptyImage = { isEmpty: () => false };

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

function resetClipboard({
  text = "",
  html = "",
  rtf = "",
  image = null,
  formats = ["text/plain"],
} = {}) {
  fakeClipboard.text = text;
  fakeClipboard.html = html;
  fakeClipboard.rtf = rtf;
  fakeClipboard.image = image;
  fakeClipboard.formats = formats;
  fakeClipboard.writes = [];
}

test("restore preserves rich clipboard formats atomically", () => {
  resetClipboard({
    formats: ["text/html", "text/rtf", "text/plain", "image/png"],
    text: "plain before",
    html: "<b>html before</b>",
    rtf: "{\\rtf1 before}",
    image: nonEmptyImage,
  });
  const manager = new ClipboardManager();

  const snapshot = manager._saveClipboard();
  fakeClipboard.writeText("dictated text");
  manager._restoreClipboard(snapshot);

  assert.deepEqual([...fakeClipboard.availableFormats()].sort(), [
    "image/png",
    "text/html",
    "text/plain",
    "text/rtf",
  ]);
  assert.equal(fakeClipboard.text, "plain before");
  assert.equal(fakeClipboard.html, "<b>html before</b>");
  assert.equal(fakeClipboard.rtf, "{\\rtf1 before}");
  assert.equal(fakeClipboard.image, nonEmptyImage);
  assert.equal(fakeClipboard.writes.at(-1)[0], "write");
});

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
