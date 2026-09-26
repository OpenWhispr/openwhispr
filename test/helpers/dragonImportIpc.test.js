const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const importDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-dragon-ipc-"));

const txtPath = path.join(importDir, "dragon-words.txt");
fs.writeFileSync(
  txtPath,
  "@Version=Plato-UTF8\r\nApplas\r\nRobert F. Kennedy\\\\RFK\r\n\\\\stray\r\n"
);
const xmlPath = path.join(importDir, "dragon-words.xml");
fs.writeFileSync(
  xmlPath,
  Buffer.from(
    '﻿<?xml version="1.0" encoding="utf-16"?>\n<WordExport NatspeakVersion="16.0"><Word name="Oertli"><Property id="1"/></Word></WordExport>',
    "utf16le"
  )
);
const bigPath = path.join(importDir, "big.txt");
fs.writeFileSync(bigPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));

let dialogResult = { canceled: false, filePaths: [txtPath] };

const electronStub = {
  app: {
    getPath: () => importDir,
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
    showOpenDialog: async () => dialogResult,
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

Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
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
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(
    new Proxy({}, { get: (value, property) => (property in value ? value[property] : anything()) })
  );
  assert.ok(handlers.get("dragon-import-pick-and-parse"), "dragon handler must be registered");
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(importDir, { recursive: true, force: true });
});

const run = () => handlers.get("dragon-import-pick-and-parse")({ sender: {} });

test("dragon import returns canceled when the picker is dismissed", async () => {
  dialogResult = { canceled: true, filePaths: [] };
  assert.deepEqual(await run(), { canceled: true });
});

test("dragon import parses a TXT export and reports unreadable lines", async () => {
  dialogResult = { canceled: false, filePaths: [txtPath] };
  const result = await run();
  assert.deepEqual(result, {
    canceled: false,
    success: true,
    fileName: "dragon-words.txt",
    format: "txt",
    words: ["Applas", "Robert F. Kennedy"],
    totalEntries: 3,
    unreadableLines: 1,
    propertiesIgnored: false,
  });
});

test("dragon import parses a UTF-16 XML export and flags ignored properties", async () => {
  dialogResult = { canceled: false, filePaths: [xmlPath] };
  const result = await run();
  assert.equal(result.success, true);
  assert.equal(result.format, "xml");
  assert.deepEqual(result.words, ["Oertli"]);
  assert.equal(result.propertiesIgnored, true);
});

test("dragon import refuses an oversized file before reading it", async () => {
  dialogResult = { canceled: false, filePaths: [bigPath] };
  assert.deepEqual(await run(), { canceled: false, success: false, error: "FILE_TOO_LARGE" });
});

test("dragon import reports READ_FAILED for a missing file", async () => {
  dialogResult = { canceled: false, filePaths: [path.join(importDir, "missing.txt")] };
  assert.deepEqual(await run(), { canceled: false, success: false, error: "READ_FAILED" });
});
