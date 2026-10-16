const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadWithDialogSpy(t) {
  const dialogs = [];
  const originalLoad = Module._load;
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { isReady: () => false },
        dialog: { showMessageBox: (options) => dialogs.push(options) },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  // ensureYdotool requires its logger lazily, so the stub stays until the test ends.
  const modulePath = require.resolve("../../src/helpers/ensureYdotool");
  delete require.cache[modulePath];
  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  });
  return { ...require(modulePath), dialogs };
}

// An empty PATH makes every ydotool probe fail, so the setup always looks
// incomplete regardless of the machine running the test.
function waylandWithoutYdotool(t) {
  const saved = {
    PATH: process.env.PATH,
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
  };
  process.env.PATH = "";
  process.env.XDG_SESSION_TYPE = "wayland";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("hasCompositorPaste accepts the portal, wtype and Hyprland's sendshortcut", (t) => {
  const { hasCompositorPaste } = loadWithDialogSpy(t);
  assert.equal(hasCompositorPaste({ tools: ["portal"] }), true);
  assert.equal(hasCompositorPaste({ tools: ["xdotool", "wtype"] }), true);
  assert.equal(hasCompositorPaste({ tools: ["hyprland-sendshortcut"] }), true);
  assert.equal(hasCompositorPaste({ tools: ["xdotool", "ydotool"] }), false);
  assert.equal(hasCompositorPaste({ tools: [] }), false);
  assert.equal(hasCompositorPaste(undefined), false);
});

test(
  "no ydotool warning when the compositor can paste",
  { skip: process.platform !== "linux" },
  async (t) => {
    waylandWithoutYdotool(t);
    const { ensureYdotool, dialogs } = loadWithDialogSpy(t);

    await ensureYdotool({ checkPasteTools: () => ({ tools: ["portal"] }) });

    assert.equal(dialogs.length, 0);
  }
);

test(
  "ydotool warning when no compositor paste exists",
  { skip: process.platform !== "linux" },
  async (t) => {
    waylandWithoutYdotool(t);
    const { ensureYdotool, dialogs } = loadWithDialogSpy(t);

    await ensureYdotool({ checkPasteTools: () => ({ tools: ["xdotool"] }) });

    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].title, "Wayland Paste Setup");
  }
);
