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

test("paste-text on Linux hands back the keyboard the assistant panel took before pasting", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    for (const [platform, expected] of [
      ["linux", ["blur", "return", "paste"]],
      ["win32", ["blur", "paste"]],
    ]) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const order = [];
      target.windowManager = {
        isOnboardingDemoActive: () => false,
        mainWindow: {
          isDestroyed: () => false,
          isFocused: () => true,
          blur: () => order.push("blur"),
        },
        // blur() leaves X focus on the Linux pill, so the paste would land in
        // the panel instead of the user's app.
        returnLinuxKeyboardFocus: () => order.push("return"),
      };
      target.clipboardManager = {
        pasteText: async () => {
          order.push("paste");
        },
      };

      await handlers.get("paste-text")({ sender: { id: 1 } }, "dictated with the panel open");

      assert.deepEqual(order, expected, platform);
    }
  } finally {
    Object.defineProperty(process, "platform", original);
  }
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

test("raw paste skips smart spacing and AutoLearn", async (t) => {
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
  const pastes = [];
  target.clipboardManager = {
    pasteText: async (text, options) => {
      pastes.push({ text, options });
    },
  };

  const result = await handlers.get("paste-text")({ sender: { id: 1 } }, "ls -la", { raw: true });

  assert.deepEqual(result, { success: true, pasted: true });
  assert.deepEqual(
    pastes.map((paste) => paste.text),
    ["ls -la"]
  );
  assert.equal("raw" in pastes[0].options, false, "the option stays in this handler");
  assert.deepEqual(monitored, []);
});

test("a normal paste still adds its smart space", async () => {
  target.windowManager = { isOnboardingDemoActive: () => false };
  const pastes = [];
  target.clipboardManager = {
    pasteText: async (text) => {
      pastes.push(text);
    },
  };

  await handlers.get("paste-text")({ sender: { id: 1 } }, "ls -la");

  assert.deepEqual(pastes, ["ls -la "]);
});

test("raw paste still hands focus back on Linux and Windows", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    for (const [platform, expected] of [
      ["linux", ["blur", "return", "paste ls -la"]],
      ["win32", ["blur", "paste ls -la"]],
    ]) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const order = [];
      target.windowManager = {
        isOnboardingDemoActive: () => false,
        mainWindow: {
          isDestroyed: () => false,
          isFocused: () => true,
          blur: () => order.push("blur"),
        },
        returnLinuxKeyboardFocus: () => order.push("return"),
      };
      target.clipboardManager = {
        pasteText: async (text) => {
          order.push(`paste ${text}`);
        },
      };

      await handlers.get("paste-text")({ sender: { id: 1 } }, "ls -la", { raw: true });

      assert.deepEqual(order, expected, platform);
    }
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

async function onPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("Paste into app pastes nothing when the panel has no app to paste into", async () => {
  let pasted = 0;
  target.windowManager = {
    isOnboardingDemoActive: () => false,
    assistantPasteTarget: { current: async () => null },
  };
  target.clipboardManager = { pasteText: async () => (pasted += 1) };

  const result = await handlers.get("paste-text")({ sender: {} }, "ls -la", {
    raw: true,
    assistantTarget: true,
  });

  assert.deepEqual(result, { success: false, pasted: false, reason: "no-target" });
  assert.equal(pasted, 0);
});

test("Paste into app on macOS brings forward the command's app, never the last dictation's", async (t) => {
  t.after(() => {
    target.textEditMonitor = null;
  });
  const activated = [];
  const pastes = [];
  target.textEditMonitor = {
    lastTargetPid: 111,
    activateTargetPid: async () => assert.fail("must not use the last dictation's app"),
    activatePid: async (pid) => {
      activated.push(pid);
      return pid === 222;
    },
  };
  target.windowManager = {
    isOnboardingDemoActive: () => false,
    assistantPasteTarget: { current: async () => ({ pid: 222 }) },
  };
  target.clipboardManager = { pasteText: async (text) => pastes.push(text) };

  await onPlatform("darwin", async () => {
    const ok = await handlers.get("paste-text")({ sender: {} }, "ls -la", {
      raw: true,
      assistantTarget: true,
    });
    assert.deepEqual(ok, { success: true, pasted: true });

    // The app quit or can't come forward: what is in front isn't it.
    target.windowManager.assistantPasteTarget = { current: async () => ({ pid: 333 }) };
    const refused = await handlers.get("paste-text")({ sender: {} }, "ls -la", {
      raw: true,
      assistantTarget: true,
    });
    assert.deepEqual(refused, { success: false, pasted: false, reason: "no-target" });
  });

  assert.deepEqual(activated, [222, 333]);
  assert.deepEqual(pastes, ["ls -la"]);
});

test("Paste into app on Windows restores the command's window", async () => {
  const options = [];
  target.selectionManager = {
    getWinTarget: async () => assert.fail("must not use the last dictation's window"),
  };
  target.windowManager = {
    isOnboardingDemoActive: () => false,
    assistantPasteTarget: {
      current: async () => ({ window: { kind: "win-hwnd", id: "0xbeef", exeName: "pwsh.exe" } }),
    },
  };
  target.clipboardManager = {
    pasteText: async (_text, pasteOptions) => options.push(pasteOptions),
  };

  await onPlatform("win32", () =>
    handlers.get("paste-text")({ sender: {} }, "dir", { raw: true, assistantTarget: true })
  );
  target.selectionManager = null;

  assert.equal(options[0].targetWindow, "0xbeef");
  assert.equal("assistantTarget" in options[0], false);
});

test("Paste into app on Linux pastes only once focus is back on the command's app", async () => {
  let pasted = 0;
  let focused = false;
  target.windowManager = {
    isOnboardingDemoActive: () => false,
    assistantPasteTarget: {
      current: async () => ({ window: { kind: "x11-window", id: "7" } }),
      isFocused: async () => focused,
    },
  };
  target.clipboardManager = { pasteText: async () => (pasted += 1) };
  const paste = () =>
    handlers.get("paste-text")({ sender: {} }, "ls", { raw: true, assistantTarget: true });

  await onPlatform("linux", async () => {
    assert.deepEqual(await paste(), { success: false, pasted: false, reason: "no-target" });
    focused = true;
    assert.deepEqual(await paste(), { success: true, pasted: true });
  });

  assert.equal(pasted, 1);
});

test("only the dictation window can adopt or forget the panel's paste target", async () => {
  const handler = handlers.get("assistant-paste-target");
  const calls = [];
  const webContents = {};
  target.windowManager = {
    mainWindow: { webContents },
    assistantPasteTarget: {
      adopt: async () => {
        calls.push("adopt");
        return true;
      },
      clear: () => calls.push("clear"),
    },
  };

  assert.equal(await handler({ sender: {} }, "adopt"), false);
  assert.equal(await handler({ sender: webContents }, "adopt"), true);
  assert.equal(await handler({ sender: webContents }, "forget"), false);
  assert.deepEqual(calls, ["adopt", "clear"]);
});
