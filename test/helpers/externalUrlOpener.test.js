const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const openerModulePath = require.resolve("../../src/helpers/externalUrlOpener");
const originalLoad = Module._load;
const originalPlatform = process.platform;
const originalSystemRoot = process.env.SystemRoot;

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function setSystemRoot(value) {
  if (value === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = value;
}

function makeChild() {
  const child = new EventEmitter();
  child.unrefCalls = 0;
  child.unref = () => {
    child.unrefCalls += 1;
  };
  return child;
}

// Returns the helper plus the spawn and shell.openExternal calls it made.
// spawnOutcome picks which child-process event the mock spawn fires.
function loadOpener({ spawnOutcome = "spawn" } = {}) {
  delete require.cache[openerModulePath];

  const spawnCalls = [];
  const openExternalCalls = [];
  const spawn = (command, args, options) => {
    const child = makeChild();
    spawnCalls.push({ command, args, options, child });
    process.nextTick(() => {
      if (spawnOutcome === "error") {
        child.emit("error", new Error("spawn failed"));
      } else {
        child.emit("spawn");
      }
    });
    return child;
  };

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        shell: {
          openExternal: (url) => {
            openExternalCalls.push(url);
            return Promise.resolve();
          },
        },
      };
    }
    if (request === "child_process") {
      return { ...childProcess, spawn };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { openExternalUrl } = require(openerModulePath);
    return { openExternalUrl, spawnCalls, openExternalCalls };
  } finally {
    Module._load = originalLoad;
  }
}

afterEach(() => {
  Module._load = originalLoad;
  setPlatform(originalPlatform);
  setSystemRoot(originalSystemRoot);
});

test("win32 https URLs launch through explorer.exe, outside our process tree", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener();
  setPlatform("win32");
  setSystemRoot("C:\\WINDOWS");

  await openExternalUrl("https://meet.google.com/abc-defg-hij");

  assert.equal(openExternalCalls.length, 0);
  assert.equal(spawnCalls.length, 1);
  // Absolute path: a bare "explorer.exe" would resolve from the CWD first.
  assert.equal(spawnCalls[0].command, "C:\\WINDOWS\\explorer.exe");
  assert.deepEqual(spawnCalls[0].args, ["https://meet.google.com/abc-defg-hij"]);
  assert.deepEqual(spawnCalls[0].options, { detached: true, stdio: "ignore", windowsHide: true });
  assert.equal(spawnCalls[0].child.unrefCalls, 1);
});

test("explorer.exe path falls back to C:\\Windows when SystemRoot is unset", async () => {
  const { openExternalUrl, spawnCalls } = loadOpener();
  setPlatform("win32");
  setSystemRoot(undefined);

  await openExternalUrl("https://meet.google.com/abc-defg-hij");

  assert.equal(spawnCalls[0].command, "C:\\Windows\\explorer.exe");
});

test("win32 http URLs take the explorer.exe path too", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener();
  setPlatform("win32");

  await openExternalUrl("http://example.com/join");

  assert.equal(openExternalCalls.length, 0);
  assert.deepEqual(spawnCalls[0].args, ["http://example.com/join"]);
});

test("explorer.exe receives a single percent-encoded argv token", async () => {
  const { openExternalUrl, spawnCalls } = loadOpener();
  setPlatform("win32");

  await openExternalUrl('https://example.com/join room "4"');

  assert.deepEqual(spawnCalls[0].args, ["https://example.com/join%20room%20%224%22"]);
});

test("win32 query-string URLs go to shell.openExternal — explorer.exe opens File Explorer instead of the browser for them", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener();
  setPlatform("win32");

  const oauthUrl =
    "https://auth.openwhispr.com/api/desktop-signin/google?callbackURL=openwhispr%3A%2F%2Fauth";
  await openExternalUrl(oauthUrl);

  assert.equal(spawnCalls.length, 0);
  assert.deepEqual(openExternalCalls, [oauthUrl]);
});

test("a bare trailing ? still counts as a query string for the explorer.exe gate", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener();
  setPlatform("win32");

  // URL.search reports "" here, but the serialized href explorer.exe receives
  // keeps the "?" — the gate must judge the delivered token, not the parse.
  await openExternalUrl("https://example.com/checkout?");

  assert.equal(spawnCalls.length, 0);
  assert.deepEqual(openExternalCalls, ["https://example.com/checkout?"]);
});

test("win32 fragment URLs go to shell.openExternal — explorer.exe mishandles them too", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener();
  setPlatform("win32");

  await openExternalUrl("https://docs.openwhispr.com/changelog#windows");

  assert.equal(spawnCalls.length, 0);
  assert.deepEqual(openExternalCalls, ["https://docs.openwhispr.com/changelog#windows"]);
});

test("win32 URLs with explorer's = or , argv separators go to shell.openExternal", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener();
  setPlatform("win32");

  // Neither URL has a query string or fragment — the separator alone breaks
  // explorer.exe's argument parsing (rauschma/openurl#2, superuser 1552619).
  await openExternalUrl("https://example.com/products/id=42");
  await openExternalUrl("https://example.com/maps/@37.77,-122.41");

  assert.equal(spawnCalls.length, 0);
  assert.deepEqual(openExternalCalls, [
    "https://example.com/products/id=42",
    "https://example.com/maps/@37.77,-122.41",
  ]);
});

test("win32 mailto URLs fall through to shell.openExternal untouched", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener();
  setPlatform("win32");

  await openExternalUrl("mailto:someone@example.com");

  assert.equal(spawnCalls.length, 0);
  assert.deepEqual(openExternalCalls, ["mailto:someone@example.com"]);
});

test("non-win32 platforms always use shell.openExternal", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener();

  for (const platform of ["darwin", "linux"]) {
    setPlatform(platform);
    await openExternalUrl("https://meet.google.com/abc-defg-hij");
  }

  assert.equal(spawnCalls.length, 0);
  assert.deepEqual(openExternalCalls, [
    "https://meet.google.com/abc-defg-hij",
    "https://meet.google.com/abc-defg-hij",
  ]);
});

test("invalid URLs reject without launching anything", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener();
  setPlatform("win32");

  await assert.rejects(openExternalUrl("not a url"), TypeError);

  assert.equal(spawnCalls.length, 0);
  assert.equal(openExternalCalls.length, 0);
});

test("an unspawnable explorer.exe still opens the link, in-process", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener({ spawnOutcome: "error" });
  setPlatform("win32");

  await openExternalUrl("https://example.com/join");

  // Degraded capture (the browser may land inside the excluded process tree)
  // beats a Join button that does nothing on shell-less Windows images.
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(openExternalCalls, ["https://example.com/join"]);
});
