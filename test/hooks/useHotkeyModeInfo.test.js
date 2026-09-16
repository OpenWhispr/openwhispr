const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

async function mount(t, { slot = "dictation", initialHotkey = "RightCommand" } = {}) {
  let root;
  let i18n;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    if (i18n) await i18n.changeLanguage("en");
  });
  const requests = [];
  const denialSubscribers = new Set();
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onLinuxPttPermissionDenied: (callback) => {
          denialSubscribers.add(callback);
          return () => denialSubscribers.delete(callback);
        },
        getHotkeyModeInfo: (hotkey, slot, language) =>
          new Promise((resolve) => requests.push({ hotkey, slot, language, resolve })),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t);
  ({ default: i18n } = await vite.ssrLoadModule("/i18n.ts"));
  await i18n.changeLanguage("en");
  const { useHotkeyModeInfo } = await vite.ssrLoadModule("/hooks/useHotkeyModeInfo.ts");
  let hotkey = initialHotkey;
  let result;
  function Harness() {
    result = useHotkeyModeInfo("settings", hotkey, slot);
    return null;
  }
  root = createRoot(container);
  const render = async (key = hotkey) => {
    hotkey = key;
    await React.act(async () => root.render(React.createElement(Harness)));
  };
  const resolve = async (
    index,
    supportsPushToTalk,
    reason = "This shortcut cannot Hold",
    linuxPttPermissionDenied = false
  ) => {
    await React.act(async () => {
      requests[index].resolve({
        isUsingNativeShortcut: true,
        isUsingHyprland: false,
        supportsPushToTalk,
        linuxPttPermissionDenied,
        pushToTalkUnavailableReason: supportsPushToTalk ? null : reason,
      });
    });
  };
  const changeLanguage = async (language) => {
    await React.act(async () => i18n.changeLanguage(language));
  };
  await render();
  return {
    render,
    resolve,
    changeLanguage,
    requests,
    result: () => result,
    subscribers: () => denialSubscribers.size,
    deny: async () => {
      await React.act(async () => {
        for (const callback of denialSubscribers) callback();
      });
    },
    remount: async () => {
      await React.act(async () => root.unmount());
      root = createRoot(container);
      await render();
    },
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

test("an edited shortcut is unresolved until its own capability answer arrives", async (t) => {
  const h = await mount(t);
  assert.equal(h.result().loaded, false);
  await h.resolve(0, true);
  assert.equal(h.result().loaded, true);
  await h.render("Control+Super");
  assert.equal(h.result().loaded, false, "the previous key's Hold support is not current");
  assert.equal(h.result().isUsingNativeShortcut, true, "editor backend limits remain stable");
  await h.resolve(1, false);
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().supportsPushToTalk, false);
});

test("a late answer for a replaced shortcut cannot restore stale guidance", async (t) => {
  const h = await mount(t);
  await h.render("F9");
  await h.resolve(0, true);
  assert.equal(h.result().loaded, false);
  await h.resolve(1, false);
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().supportsPushToTalk, false);
});

test("returning to an earlier key still waits for its fresh check", async (t) => {
  const h = await mount(t);
  await h.resolve(0, true);
  await h.render("F9");
  await h.render("RightCommand");
  assert.equal(h.result().loaded, false);
  await h.resolve(1, true);
  assert.equal(h.result().loaded, false);
  await h.resolve(2, false);
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().supportsPushToTalk, false);
});

for (const slot of ["dictation", "voiceAgent", "translation"]) {
  test(`a mounted ${slot} capability refreshes its language and hides the previous explanation`, async (t) => {
    const h = await mount(t, { slot, initialHotkey: "Control+Super" });
    await h.resolve(0, false, "This shortcut has no regular key");
    await h.changeLanguage("de");

    assert.equal(h.requests.length, 2, "changing language refreshes a mounted Settings hook");
    const { hotkey, slot: requestedSlot, language } = h.requests[1];
    assert.deepEqual(
      { hotkey, slot: requestedSlot, language },
      { hotkey: "Control+Super", slot, language: "de" }
    );
    assert.equal(h.result().loaded, false);
    assert.equal(h.result().pushToTalkUnavailableReason, null);
    assert.equal(h.result().isUsingNativeShortcut, true, "backend limits remain stable");
    await h.resolve(1, false, "Diese Tastenkombination enthält keine normale Taste");
    assert.equal(h.result().loaded, true);
    assert.match(h.result().pushToTalkUnavailableReason, /enthält keine normale Taste/);

    await h.changeLanguage("en");
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].language, "en");
    assert.equal(h.result().pushToTalkUnavailableReason, null);
    await h.resolve(2, false, "This shortcut has no regular key");
    assert.match(h.result().pushToTalkUnavailableReason, /has no regular key/);
  });
}

test("a late English answer cannot replace current German guidance", async (t) => {
  const h = await mount(t);
  await h.changeLanguage("de");
  assert.equal(h.requests.length, 2);
  await h.resolve(1, false, "Aktuelle deutsche Erklärung");
  await h.resolve(0, false, "Stale English explanation");
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().pushToTalkUnavailableReason, "Aktuelle deutsche Erklärung");
});

test("English to German to English waits for the newest English request", async (t) => {
  const h = await mount(t);
  await h.changeLanguage("de");
  await h.changeLanguage("en");
  assert.equal(h.requests.length, 3);
  await h.resolve(0, false, "First English explanation");
  assert.equal(h.result().loaded, false);
  assert.equal(h.result().pushToTalkUnavailableReason, null);
  await h.resolve(1, false, "Verspätete deutsche Erklärung");
  assert.equal(h.result().loaded, false);
  await h.resolve(2, false, "Fresh English explanation");
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().pushToTalkUnavailableReason, "Fresh English explanation");
});

test("interleaved language and shortcut edits retain only their latest answer", async (t) => {
  const h = await mount(t, { slot: "translation" });
  await h.resolve(0, false, "Old shortcut explanation");
  await h.changeLanguage("de");
  await h.render("Control+Super");
  await h.changeLanguage("en");
  assert.deepEqual(
    h.requests.map(({ hotkey, slot, language }) => ({ hotkey, slot, language })),
    [
      { hotkey: "RightCommand", slot: "translation", language: "en" },
      { hotkey: "RightCommand", slot: "translation", language: "de" },
      { hotkey: "Control+Super", slot: "translation", language: "de" },
      { hotkey: "Control+Super", slot: "translation", language: "en" },
    ]
  );
  await h.resolve(2, false, "New shortcut in the old language");
  await h.resolve(1, false, "Old shortcut in the old language");
  assert.equal(h.result().loaded, false);
  assert.equal(h.result().pushToTalkUnavailableReason, null);
  await h.resolve(3, false, "Current shortcut in English");
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().pushToTalkUnavailableReason, "Current shortcut in English");
});

test("a saved denial is read on mount and again after reopening Settings", async (t) => {
  const h = await mount(t);
  assert.equal(h.result().linuxPttPermissionDenied, false);
  await h.resolve(0, true, undefined, true);
  assert.equal(h.result().linuxPttPermissionDenied, true);
  await h.remount();
  assert.equal(h.result().loaded, false);
  await h.resolve(1, true, undefined, true);
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().linuxPttPermissionDenied, true);
});

test("a denial event rechecks capabilities and releases its subscription on unmount", async (t) => {
  const h = await mount(t);
  assert.equal(h.subscribers(), 1);
  await h.resolve(0, true);
  await h.deny();
  assert.equal(h.requests.length, 2);
  assert.equal(h.result().loaded, false);
  await h.resolve(1, true, undefined, true);
  assert.equal(h.result().linuxPttPermissionDenied, true);
  await h.unmount();
  assert.equal(h.subscribers(), 0);
  await h.deny();
  assert.equal(h.requests.length, 2);
});

test("a late pre-denial answer cannot erase a newer permission diagnostic", async (t) => {
  const h = await mount(t);
  await h.deny();
  assert.equal(h.requests.length, 2);
  await h.resolve(1, true, undefined, true);
  await h.resolve(0, true, undefined, false);
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().linuxPttPermissionDenied, true);
});

test("denial refresh also supersedes an in-flight shortcut edit", async (t) => {
  const h = await mount(t);
  await h.resolve(0, true);
  await h.render("F9");
  await h.deny();
  assert.equal(h.requests.length, 3);
  await h.resolve(1, true, undefined, false);
  assert.equal(h.result().loaded, false);
  await h.resolve(2, true, undefined, true);
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().linuxPttPermissionDenied, true);
});

test("interleaved language, shortcut and permission changes keep only their newest answer", async (t) => {
  const h = await mount(t, { slot: "translation", initialHotkey: "Control+Space" });
  await h.changeLanguage("de");
  await h.render("F9");
  await h.deny();
  assert.deepEqual(
    h.requests.map(({ hotkey, language }) => ({ hotkey, language })),
    [
      { hotkey: "Control+Space", language: "en" },
      { hotkey: "Control+Space", language: "de" },
      { hotkey: "F9", language: "de" },
      { hotkey: "F9", language: "de" },
    ]
  );
  await h.resolve(3, true, undefined, true);
  await h.resolve(2, false, "Stale German shortcut explanation");
  await h.resolve(1, true, undefined, false);
  await h.resolve(0, false, "Stale English explanation");
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().supportsPushToTalk, true);
  assert.equal(h.result().linuxPttPermissionDenied, true);
  assert.equal(h.result().pushToTalkUnavailableReason, null);

  await h.changeLanguage("en");
  assert.equal(h.requests[4].language, "en");
  assert.equal(h.result().loaded, false);
  await h.resolve(4, true, undefined, true);
  assert.equal(h.result().loaded, true);
  assert.equal(h.result().linuxPttPermissionDenied, true);
});
