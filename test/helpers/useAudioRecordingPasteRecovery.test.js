const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
const permission = {
  title: "Paste Error",
  code: "ACCESSIBILITY_PERMISSION_REQUIRED",
  clipboardCopied: true,
};
const finalText = "  Final translated text\nwith spacing  ";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mount(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__pasteRecoveryManager;
  });
  const toasts = [],
    writes = [],
    shown = [],
    hidden = [],
    dismissed = [];
  let settingsCalls = 0;
  const noopDispose = () => () => {};
  const { window } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onStopDictation: noopDispose,
        hideDictationPreview: async () => hidden.push(true),
        completeDictationPreview: async () => {},
        dictationLifecycleStateChanged: () => {},
        openAccessibilitySettings: async () => {
          settingsCalls += 1;
          return { success: true };
        },
        writeClipboard: async (text) => {
          writes.push(text);
          return { success: true };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-paste-recovery-hook-",
    mockModules: {
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/utils/visualFrame": "export async function waitForVisualFrames() {}",
      "/helpers/audioManager": `export default class FakeAudioManager {
      constructor() { this.voiceAgentRequested=false; this.sttConfig={success:true}; this.streamingFinalText="raw words"; this.starts=0; this.saves=0; globalThis.__pasteRecoveryManager=this; }
      setCallbacks(callbacks) { this.callbacks=callbacks; }
      getState() { return { isRecording:false, isProcessing:false }; }
      shouldUseStreaming() { return false; }
      setVoiceAgentRequested(value) { this.voiceAgentRequested=value; }
      setAssistantSelectionContext() {}
      setTranslationRequested() {}
      async startRecording() { this.starts+=1; return true; }
      async safePaste(text) { this.callbacks.onError({title:"Paste Error",code:"ACCESSIBILITY_PERMISSION_REQUIRED",clipboardCopied:true,transcript:text}); return false; }
      async saveTranscription() { this.saves+=1; return true; }
      cleanup() {}
    }`,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  useSettingsStore.setState({
    autoPasteEnabled: false,
    keepTranscriptionInClipboard: false,
    snippets: [],
    useLocalWhisper: true,
    pauseMediaOnDictation: false,
  });
  let recording;
  const toast = (value) => toasts.push(value);
  const options = {
    onShowTranscript: (value) => shown.push(value),
    dismissDictationError: () => dismissed.push(true),
  };
  function Harness() {
    recording = useAudioRecording(toast, options);
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const manager = globalThis.__pasteRecoveryManager;
  return {
    toasts,
    writes,
    shown,
    hidden,
    dismissed,
    manager,
    settings: useSettingsStore,
    api: window.electronAPI,
    recording: () => recording,
    settingsCalls: () => settingsCalls,
    changeLanguage: async (language) => React.act(async () => i18n.changeLanguage(language)),
    error: async (error = { ...permission, transcript: finalText }) =>
      React.act(async () => manager.callbacks.onError(error)),
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

test("permission recovery preserves final text and keeps Settings and Copy on the same card", async (t) => {
  const h = await mount(t);
  await h.error();
  const card = h.toasts.at(-1);
  assert.equal(card.duration, 0);
  assert.equal(card.dismissible, true);
  assert.equal(card.presentation, "dictation-error");
  assert.equal(card.actions[0].icon, "settings");
  assert.equal(card.actions[1].icon, "copy");
  assert.equal(card.actions[0].dismissOnClick, false);
  assert.equal(card.actions[1].dismissOnClick, false);
  await card.actions[0].onClick();
  assert.equal(h.settingsCalls(), 1);
  assert.equal(await card.actions[1].onClick(), true);
  assert.deepEqual(h.writes, [finalText]);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.manager.starts, 0);
  assert.deepEqual(h.shown, []);
  assert.deepEqual(h.hidden, []);
});

test("a visible permission card keeps its actions working after changing the app language", async (t) => {
  const h = await mount(t);
  await h.error();
  const card = h.toasts.at(-1);
  const copy = deferred();
  h.api.writeClipboard = async (text) => {
    h.writes.push(text);
    return copy.promise;
  };
  const pendingCopy = card.actions[1].onClick();
  await h.changeLanguage("de");
  copy.resolve({ success: true });
  assert.equal(await pendingCopy, true);
  assert.equal(h.toasts.length, 1);
  await card.actions[0].onClick();
  assert.equal(h.settingsCalls(), 1);
  assert.equal(await card.actions[1].onClick(), true);
  assert.deepEqual(h.writes, [finalText, finalText]);
});

test("copy reports only strict bridge success and never falls back or replaces the card", async (t) => {
  const h = await mount(t);
  await h.error();
  const copy = h.toasts.at(-1).actions[1];
  for (const result of [true, false, undefined, "reject", "absent"]) {
    h.api.writeClipboard =
      result === "absent"
        ? undefined
        : async () => {
            if (result === "reject") throw new Error("locked");
            return result === undefined ? undefined : { success: result };
          };
    assert.equal(await copy.onClick(), result === true);
  }
  assert.equal(h.toasts.length, 1);
  assert.equal(h.settingsCalls(), 0);
  assert.equal(h.manager.starts, 0);
  for (const transcript of ["", " \n "]) {
    await h.error({ ...permission, transcript });
    assert.equal(h.toasts.at(-1).actions.length, 1);
    assert.doesNotMatch(h.toasts.at(-1).description, /Copy your text/);
    assert.equal(h.toasts.at(-1).descriptionHotkey, undefined);
  }
});

test("Settings failures retain a persistent manual path and exact-text copy", async (t) => {
  const h = await mount(t);
  for (const result of [false, undefined, "reject", "absent"]) {
    h.api.openAccessibilitySettings =
      result === "absent"
        ? undefined
        : async () => {
            if (result === "reject") throw new Error("unavailable");
            return result === undefined ? undefined : { success: result };
          };
    await h.error();
    await h.toasts.at(-1).actions[0].onClick();
    const fallback = h.toasts.at(-1);
    assert.match(fallback.description, /Couldn't open Settings/);
    assert.match(fallback.description, /System Settings.*Accessibility/);
    assert.equal(fallback.duration, 0);
    assert.equal(fallback.dismissible, true);
    assert.equal(await fallback.actions[1].onClick(), true);
    assert.equal(h.writes.at(-1), finalText);
  }
  h.api.openAccessibilitySettings = async () => ({ success: true });
  const count = h.toasts.length;
  await h.toasts.at(-1).actions[0].onClick();
  assert.equal(h.toasts.length, count, "fallback action remains usable");
});

for (const transition of ["close", "newer error", "start", "complete", "unmount"]) {
  test(`late Settings and Copy results cannot survive ${transition}`, async (t) => {
    const h = await mount(t);
    await h.error();
    const old = h.toasts.at(-1);
    const settings = deferred(),
      copy = deferred();
    let launches = 0,
      writes = 0;
    h.api.openAccessibilitySettings = () => {
      launches += 1;
      return settings.promise;
    };
    h.api.writeClipboard = () => {
      writes += 1;
      return copy.promise;
    };
    const pendingSettings = old.actions[0].onClick();
    await old.actions[0].onClick();
    assert.equal(launches, 1);
    const pendingCopy = old.actions[1].onClick();
    if (transition === "close") old.onClose();
    if (transition === "newer error") {
      await h.error({ ...permission, transcript: "new final text" });
      old.onClose();
    }
    if (transition === "start") {
      await React.act(async () => assert.equal(await h.recording().startRecording(), true));
      assert.equal(h.manager.starts, 1);
    }
    if (transition === "complete") {
      await React.act(async () =>
        h.manager.callbacks.onTranscriptionComplete({
          success: true,
          text: "new text",
          source: "local",
        })
      );
      assert.equal(h.dismissed.length, 1);
    }
    if (transition === "unmount") await h.unmount();
    const count = h.toasts.length;
    settings.reject(new Error("late"));
    copy.resolve({ success: true });
    await pendingSettings;
    assert.equal(await pendingCopy, undefined);
    await old.actions[1].onClick();
    assert.equal(writes, 1, "already stale copy does not dispatch");
    assert.equal(h.toasts.length, count);
    if (transition === "newer error") {
      const actual = [];
      h.api.writeClipboard = async (text) => {
        actual.push(text);
        return { success: true };
      };
      assert.equal(await h.toasts.at(-1).actions[1].onClick(), true);
      assert.deepEqual(actual, ["new final text"]);
    }
  });
}

test("generic errors retain Retry and transcript behavior with neutral paste wording", async (t) => {
  const h = await mount(t);
  await h.error({
    title: "Paste Error",
    code: "PASTE_FAILED",
    description: "accessibility internal details",
  });
  const card = h.toasts.at(-1);
  assert.equal(card.actions[0].icon, "retry");
  assert.equal(card.actions[1].icon, "transcript");
  assert.doesNotMatch(card.description, /accessibility|internal/i);
  assert.equal(card.duration, undefined);
  assert.equal(card.dismissible, undefined);
  card.actions[1].onClick();
  assert.deepEqual(h.shown, ["raw words"]);
  await h.error({ title: "Other error", description: "details" });
  assert.equal(h.hidden.length, 1);
});

test("completed batch and streaming dictations are saved when automatic paste is denied", async (t) => {
  const h = await mount(t);
  h.settings.setState({ autoPasteEnabled: true });
  for (const source of ["local", "streaming"]) {
    await React.act(async () =>
      h.manager.callbacks.onTranscriptionComplete({
        success: true,
        text: "final result",
        rawText: "raw input",
        source,
      })
    );
    assert.equal(h.toasts.at(-1).actions[1].icon, "copy");
  }
  assert.equal(h.manager.saves, 2);
});
