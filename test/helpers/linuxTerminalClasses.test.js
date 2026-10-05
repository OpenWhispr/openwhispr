const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const clipboardModulePath = require.resolve("../../src/helpers/clipboard");
const originalLoad = Module._load;

function loadClipboardManager() {
  delete require.cache[clipboardModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        clipboard: {
          readText() {
            return "";
          },
          writeText() {},
        },
        systemPreferences: { isTrustedAccessibilityClient: () => true },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../../src/helpers/clipboard");
  } finally {
    Module._load = originalLoad;
  }
}

const ClipboardManager = loadClipboardManager();

test("Ptyxis and GNOME Console window classes are terminals", () => {
  const clipboard = new ClipboardManager();
  assert.equal(clipboard.isLinuxTerminalWindowClass("org.gnome.Ptyxis"), true);
  assert.equal(clipboard.isLinuxTerminalWindowClass("ptyxis"), true);
  assert.equal(clipboard.isLinuxTerminalWindowClass("org.gnome.Console"), true);
  assert.equal(clipboard.isLinuxTerminalWindowClass("kgx"), true);
});

test("existing terminals still match", () => {
  const clipboard = new ClipboardManager();
  assert.equal(clipboard.isLinuxTerminalWindowClass("kitty"), true);
  assert.equal(clipboard.isLinuxTerminalWindowClass("ghostty"), true);
  assert.equal(clipboard.isLinuxTerminalWindowClass("gnome-terminal"), true);
});

test("ordinary GUI apps are not terminals", () => {
  const clipboard = new ClipboardManager();
  assert.equal(clipboard.isLinuxTerminalWindowClass("Code"), false);
  assert.equal(clipboard.isLinuxTerminalWindowClass("firefox"), false);
  assert.equal(clipboard.isLinuxTerminalWindowClass(""), false);
  assert.equal(clipboard.isLinuxTerminalWindowClass(null), false);
});
