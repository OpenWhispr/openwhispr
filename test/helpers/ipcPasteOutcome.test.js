const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();

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
    handle: (channel, fn) => handlers.set(channel, fn),
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
  dialog: {},
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

let target;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = {
    sessionId: "test-session",
    _autoLearnEnabled: false,
    textEditMonitor: null,
    selectionManager: null,
  };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
  assert.ok(handlers.get("paste-text"), "paste-text must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

test("paste-text reports an onboarding demo no-op without invoking the clipboard", async () => {
  let pasteCalls = 0;
  target.windowManager = { isOnboardingDemoActive: () => true };
  target.clipboardManager = {
    pasteText: async () => {
      pasteCalls += 1;
    },
  };

  const result = await handlers.get("paste-text")({ sender: {} }, "demo transcript");

  assert.deepEqual(result, { success: true, pasted: false });
  assert.equal(pasteCalls, 0);
});

test("paste-text reports pasted only after the clipboard paste completes", async () => {
  const pastes = [];
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async (text, options) => {
      pastes.push({ text, options });
    },
  };

  const result = await handlers.get("paste-text")({ sender: { id: 1 } }, "normal transcript");

  assert.deepEqual(result, { success: true, pasted: true });
  assert.equal(pastes.length, 1);
});

test("paste-text preserves a clipboard-only fallback as not pasted", async () => {
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async () => ({ pasted: false }),
  };

  const result = await handlers.get("paste-text")({ sender: { id: 1 } }, "manual transcript", {
    allowClipboardFallback: true,
  });

  assert.deepEqual(result, { success: true, pasted: false });
});

test("paste-text tells the renderer why a paste was held back", async () => {
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async () => ({ pasted: false, reason: "modifiers-held" }),
  };

  const result = await handlers.get("paste-text")({ sender: { id: 1 } }, "held transcript");

  assert.deepEqual(result, { success: true, pasted: false, reason: "modifiers-held" });
});

test("paste-text does not schedule AutoLearn monitoring after a clipboard-only fallback", async (t) => {
  const originalSetTimeout = global.setTimeout;
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    target._autoLearnEnabled = false;
    target.textEditMonitor = null;
  });
  global.setTimeout = (callback) => {
    callback();
    return 1;
  };
  const monitored = [];
  target._autoLearnEnabled = true;
  target.textEditMonitor = {
    lastTargetPid: 42,
    activateTargetPid: async () => true,
    startMonitoring: (...args) => monitored.push(args),
  };
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async () => ({ pasted: false }),
  };

  const result = await handlers.get("paste-text")({ sender: { id: 1 } }, "manual transcript", {
    allowClipboardFallback: true,
  });

  assert.deepEqual(result, { success: true, pasted: false });
  assert.deepEqual(monitored, []);
});

test("paste-text serializes only a copied Accessibility denial and skips AutoLearn", async (t) => {
  const originalTimeout = global.setTimeout;
  t.after(() => {
    global.setTimeout = originalTimeout;
    target._autoLearnEnabled = false;
    target.textEditMonitor = null;
  });
  let scheduled = 0;
  global.setTimeout = () => {
    scheduled += 1;
    return 1;
  };
  target._autoLearnEnabled = true;
  target.textEditMonitor = {
    activateTargetPid: async () => true,
    startMonitoring: () => assert.fail("must not monitor denial"),
  };
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async (_text, options) => {
      assert.equal(options.silentAccessibilityCheck, true);
      throw Object.assign(new Error("internal detail"), {
        code: "ACCESSIBILITY_PERMISSION_REQUIRED",
        clipboardCopied: true,
      });
    },
  };
  assert.deepEqual(
    await handlers.get("paste-text")({ sender: {} }, "final text", {
      silentAccessibilityCheck: false,
    }),
    {
      success: false,
      pasted: false,
      code: "ACCESSIBILITY_PERMISSION_REQUIRED",
      clipboardCopied: true,
    }
  );
  assert.equal(scheduled, 0);
});

test("paste-text preserves rejection for generic errors and unconfirmed clipboard writes", async () => {
  target.windowManager = { isOnboardingDemoActive: () => false };
  for (const error of [
    new Error("accessibility mentioned in an unrelated failure"),
    Object.assign(new Error("not copied"), { code: "ACCESSIBILITY_PERMISSION_REQUIRED" }),
  ]) {
    target.clipboardManager = {
      pasteText: async () => {
        throw error;
      },
    };
    await assert.rejects(
      handlers.get("paste-text")({ sender: {} }, "text"),
      (thrown) => thrown === error
    );
  }
});

// When activating the paste target fails, macOS hands focus back by hiding the
// focused pill for 120 ms. A display change in that gap can pin the hidden pill
// to one Space, so it must come back through the manager's Spaces-aware show.
function pasteThroughFocusHandoff(t) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    t.mock.timers.reset();
    target.textEditMonitor = null;
  });
  const calls = [];
  const pill = {
    isDestroyed: () => false,
    isFocused: () => true,
    hide: () => calls.push("hide"),
    showInactive: () => calls.push("showInactive"),
  };
  target.textEditMonitor = { activateTargetPid: async () => false };
  target.windowManager = {
    mainWindow: pill,
    isOnboardingDemoActive: () => false,
    showDictationPanel: (...args) => calls.push(["showDictationPanel", ...args]),
  };
  target.clipboardManager = { pasteText: async () => calls.push("pasteText") };
  const pasting = handlers.get("paste-text")({ sender: {} }, "dictated text");
  // Lets the handler reach its 120 ms wait.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { calls, pill, pasting, settle };
}

test("paste-text brings the hidden pill back through the manager's Spaces-aware show", async (t) => {
  const { calls, pasting, settle } = pasteThroughFocusHandoff(t);

  await settle();
  assert.deepEqual(calls, ["hide"]);

  t.mock.timers.tick(120);
  assert.deepEqual(await pasting, { success: true, pasted: true });
  assert.deepEqual(calls, ["hide", ["showDictationPanel"], "pasteText"]);
});

for (const [label, interrupt] of [
  ["destroyed", ({ pill }) => (pill.isDestroyed = () => true)],
  [
    "replaced",
    ({ calls }) =>
      (target.windowManager.mainWindow = {
        isDestroyed: () => false,
        showInactive: () => calls.push("replacement showInactive"),
      }),
  ],
]) {
  test(`paste-text leaves a pill ${label} during the focus hand-off alone`, async (t) => {
    const handoff = pasteThroughFocusHandoff(t);

    await handoff.settle();
    interrupt(handoff);
    t.mock.timers.tick(120);

    assert.deepEqual(await handoff.pasting, { success: true, pasted: true });
    assert.deepEqual(handoff.calls, ["hide", "pasteText"]);
  });
}

test("Accessibility settings opens the macOS system pane and reports launch failure", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    delete electronStub.shell.openExternal;
  });
  const urls = [];
  electronStub.shell.openExternal = async (url) => {
    urls.push(url);
  };
  assert.deepEqual(await handlers.get("open-accessibility-settings")(), { success: true });
  assert.deepEqual(urls, [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  ]);
  electronStub.shell.openExternal = async () => {
    throw new Error("launch failed");
  };
  assert.deepEqual(await handlers.get("open-accessibility-settings")(), {
    success: false,
    error: "launch failed",
  });
});
