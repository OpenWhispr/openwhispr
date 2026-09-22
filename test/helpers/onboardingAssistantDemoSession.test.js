const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
const {
  ONBOARDING_DEMO_KINDS,
  ONBOARDING_DEMO_STATUSES,
} = require("../../src/helpers/onboardingInputPolicy");

function createDemoBridge() {
  const handlers = new Map();
  const events = [];
  const listeners = new Set();
  const sentChannels = [];
  const windowSource = fs.readFileSync(
    require.resolve("../../src/helpers/windowManager.js"),
    "utf8"
  );
  const lifecycleStart = windowSource.indexOf("  beginOnboardingDemo(kind) {");
  const lifecycleEnd = windowSource.indexOf(
    "  _clearControlPanelVisibilityTimer()",
    lifecycleStart
  );
  const cancelStart = windowSource.indexOf("  sendCancelDictation() {");
  const cancelEnd = windowSource.indexOf("  getActivationMode()", cancelStart);
  assert.ok(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart);
  assert.ok(cancelStart >= 0 && cancelEnd > cancelStart);
  const DemoWindowManager = vm.runInNewContext(
    `(class {
      ${windowSource.slice(lifecycleStart, lifecycleEnd)}
      ${windowSource.slice(cancelStart, cancelEnd)}
      hideDictationPanel() {}
    })`,
    { ONBOARDING_DEMO_KINDS }
  );
  const windowManager = new DemoWindowManager();
  windowManager.hotkeyManager = { isInListeningMode: () => false };
  windowManager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel) => sentChannels.push(channel) },
  };
  const context = { windowManager, _onboardingDemoSession: null };
  const source = fs.readFileSync(require.resolve("../../src/helpers/ipcHandlers.js"), "utf8");
  const start = source.indexOf("    this.windowManager.onOnboardingDemoTeardown =");
  const end = source.indexOf('    ipcMain.handle("test-provider-connection",', start);
  assert.ok(start >= 0 && end > start, "production onboarding IPC registrations exist");
  // Execute the actual handlers, as modelManagerBridgeDownloadStatus.test.js
  // does, without starting Electron or unrelated application services.
  vm.runInNewContext(`(function () { ${source.slice(start, end)} }).call(context)`, {
    context,
    ONBOARDING_DEMO_KINDS,
    ONBOARDING_DEMO_STATUSES,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    broadcastToWindows: (_channel, event) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
  });
  const invoke = (channel, payload) => handlers.get(channel)({}, payload);
  return {
    events,
    sentChannels,
    begin: (id) => invoke("onboarding-demo-begin", { id, kind: "assistant" }),
    end: (id) => invoke("onboarding-demo-end", id),
    publish: (event) => invoke("onboarding-demo-publish", { ...event, kind: "assistant" }),
    getSession: async () => invoke("onboarding-demo-session"),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function mountAssistant(
  t,
  { electronAPI = {}, settings = {}, mockModules = {}, withAudio = false } = {}
) {
  let root;
  let reasoningService;
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    reasoningService?.destroy();
    globalThis.fetch = originalFetch;
  });
  const bridge = createDemoBridge();
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getOnboardingDemoSession: bridge.getSession,
        onOnboardingDemoEvent: bridge.subscribe,
        ...electronAPI,
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-onboarding-assistant-session-",
    mockModules,
  });
  const [{ default: i18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  await i18next.use(initReactI18next).init({
    lng: "en",
    resources: {
      en: {
        translation: JSON.parse(
          fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
        ),
      },
    },
    interpolation: { escapeValue: false },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  useSettingsStore.setState({
    dictationAgentMode: "self-hosted",
    dictationAgentProvider: "lan",
    dictationAgentModel: "qwen3-4b-q4_k_m",
    dictationAgentRemoteUrl: "http://127.0.0.1:11434/v1",
    dictationAgentDisableThinking: true,
    isSignedIn: false,
    ...settings,
  });
  const { useOnboardingAssistantDemo } = await vite.ssrLoadModule(
    "/hooks/useOnboardingAssistantDemo.ts"
  );
  reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;

  const useAudioRecording = withAudio
    ? (await vite.ssrLoadModule("/hooks/useAudioRecording.js")).useAudioRecording
    : null;
  let demo, audio;
  const toast = () => {};
  function Harness() {
    demo = useOnboardingAssistantDemo(bridge.publish);
    if (useAudioRecording)
      audio = useAudioRecording(toast, {
        onDemoEvent: createRecordingAdapter(demo.cancel, bridge.publish),
      });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return {
    bridge,
    service: reasoningService,
    policyStore: usePolicyStore,
    demo,
    audio,
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

async function drain() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function runAssistantScenario(t, replaceSession, nextStatus) {
  const { bridge, demo } = await mountAssistant(t);

  let controller;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(streamController) {
          controller = streamController;
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

  bridge.begin("old-attempt");
  await React.act(async () => {
    demo.run({ text: "Reply to Maria", attachment: null });
    for (let i = 0; i < 50 && !controller; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  assert.ok(controller, "the original Assistant request is pending before navigation");

  if (replaceSession) {
    await React.act(async () => {
      bridge.end("old-attempt");
      bridge.begin("new-attempt");
    });
  }
  if (nextStatus) await React.act(async () => bridge.publish({ status: nextStatus }));
  bridge.events.length = 0;
  await React.act(async () => {
    const chunk = {
      id: "chatcmpl-old-attempt",
      object: "chat.completion.chunk",
      created: 1,
      model: "qwen3-4b-q4_k_m",
      choices: [
        { index: 0, delta: { content: "Reply from the old attempt" }, finish_reason: null },
      ],
    };
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
    );
    controller.close();
    for (let i = 0; i < 50 && !bridge.events.some((event) => event.status === "success"); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  if (nextStatus) {
    assert.deepEqual(bridge.events, [], "the old stream cannot publish content or terminal events");
    controller = null;
    await React.act(async () => {
      await demo.run({ text: "Reply to the next command", attachment: null });
      await drain();
    });
    assert.ok(controller);
    await React.act(async () => {
      const chunk = {
        choices: [{ index: 0, delta: { content: "Current reply" }, finish_reason: null }],
      };
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
      );
      controller.close();
      await drain();
    });
    const successes = bridge.events.filter((event) => event.status === "success");
    assert.equal(successes.length, 1);
    assert.equal(successes[0].text, "Current reply");
  } else if (replaceSession) {
    assert.deepEqual(
      bridge.events.filter((event) => event.demoId === "new-attempt"),
      [],
      "a delayed reply from the old attempt must not be relabelled as the new demo"
    );
  } else {
    const successes = bridge.events.filter((event) => event.status === "success");
    assert.equal(successes.length, 1, "the active attempt completes exactly once");
    assert.equal(successes[0].demoId, "old-attempt");
    assert.equal(successes[0].text, "Reply from the old attempt");
  }
}

test("an Assistant reply started before teardown cannot complete a replacement demo session", async (t) => {
  await runAssistantScenario(t, true);
});

test("an Assistant reply completes normally while its originating demo session remains active", async (t) => {
  await runAssistantScenario(t, false);
});

test("beginning and ending practice cancel transcription processing as well as recording", () => {
  const bridge = createDemoBridge();
  bridge.begin("attempt");
  assert.ok(bridge.sentChannels.includes("cancel-dictation"), "begin cancels processing");
  bridge.sentChannels.length = 0;
  bridge.end("attempt");
  assert.ok(bridge.sentChannels.includes("cancel-dictation"), "end cancels processing");
});

test("the demo bridge rejects replies bound to a different attempt and preserves bounded error codes", () => {
  const bridge = createDemoBridge();
  bridge.begin("current-attempt");
  assert.equal(
    bridge.publish({ demoId: "old-attempt", status: "success", text: "Stale reply" }),
    false
  );
  assert.equal(bridge.events.length, 0);
  bridge.publish({ demoId: "current-attempt", status: "error", code: "AUTH_REQUIRED" });
  assert.equal(bridge.events.at(-1).code, "AUTH_REQUIRED");
  bridge.publish({ status: "error", code: "X".repeat(80) });
  assert.equal(bridge.events.at(-1).code.length, 64);
});

for (const status of ["preparing", "listening", "cancelled"]) {
  test(`same-session ${status} rejects the old reply and the next command succeeds`, async (t) => {
    await runAssistantScenario(t, false, status);
  });
}

for (const code of ["AUTH_EXPIRED", "AUTH_REQUIRED", undefined]) {
  test(`actual reasoning IPC error retains ${code ?? "generic retry"} exactly once`, async (t) => {
    let onError;
    const { bridge, demo } = await mountAssistant(t, {
      settings: {
        useDictationAgent: true,
        dictationAgentMode: "openwhispr",
        dictationAgentCloudMode: "openwhispr",
        isSignedIn: true,
      },
      electronAPI: {
        onAgentStreamError: (listener) => {
          onError = listener;
          return () => {};
        },
        startAgentStream: (requestId) => onError({ requestId, error: "Request failed", code }),
      },
    });
    bridge.begin("auth-attempt");
    await React.act(async () => {
      await demo.run({ text: "Reply", attachment: null });
      await drain();
    });
    const errors = bridge.events.filter((event) => event.status === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, code);
    assert.equal(errors[0].message, "Request failed");
    assert.equal(bridge.events.filter((event) => event.status === "success").length, 0);
  });
}

for (const action of ["cancel", "unmount"]) {
  test(`${action} invalidates pending session lookup without cancelling unrelated reasoning`, async (t) => {
    const lookup = Promise.withResolvers();
    const { demo, service, unmount } = await mountAssistant(t, {
      electronAPI: { getOnboardingDemoSession: () => lookup.promise },
    });
    const cancel = t.mock.method(service, "cancelActiveStream", () => {});
    const stream = t.mock.method(service, "processTextStreamingAI", async function* () {});
    let pending;
    await React.act(async () => {
      pending = demo.run({ text: "Reply", attachment: null });
    });
    if (action === "unmount") await unmount();
    else await React.act(async () => demo.cancel());
    await React.act(async () => {
      lookup.resolve({ id: "old-attempt", kind: "assistant" });
      await pending;
      await drain();
    });
    assert.equal(cancel.mock.callCount(), 0);
    assert.equal(stream.mock.callCount(), 0);
  });
}

function createRecordingAdapter(cancel, publish) {
  const source = fs.readFileSync(require.resolve("../../src/App.jsx"), "utf8");
  const start = source.indexOf("  const handleRecordingDemoEvent = useCallback(");
  const end = source.indexOf("\n  const assistant =", start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(
    `(() => { ${source.slice(start, end)} return handleRecordingDemoEvent; })()`,
    {
      useCallback: (callback) => callback,
      cancelOnboardingAssistantDemo: cancel,
      publishOnboardingDemoEvent: publish,
      localStorage: globalThis.localStorage,
    }
  );
}

test("completed onboarding recording adapter never cancels or publishes a normal Assistant request", (t) => {
  const { storage } = installBrowserGlobals(t, { initialStorage: { onboardingCompleted: "true" } });
  const calls = [];
  const adapter = createRecordingAdapter(
    () => calls.push("cancel"),
    () => calls.push("publish")
  );
  adapter({ kind: "assistant", status: "preparing" });
  assert.deepEqual(calls, []);
  storage.setItem("onboardingCompleted", "false");
  adapter({ kind: "dictation", status: "preparing" });
  assert.deepEqual(calls, ["publish"]);
  calls.length = 0;
  adapter({ kind: "assistant", status: "preparing" });
  assert.deepEqual(calls, ["cancel", "publish"], "cancellation happens synchronously before IPC");
});

for (const tail of ["success", "error"]) {
  for (const boundary of ["frames", "target"]) {
    test(`accepted recording suppresses old ${tail} while ${boundary} remains unresolved`, async (t) => {
      const frames = Promise.withResolvers();
      const target = Promise.withResolvers();
      const old = Promise.withResolvers();
      globalThis.__demoVisualFrames = frames.promise;
      t.after(() => {
        delete globalThis.__demoVisualFrames;
      });
      let captureStarted = false;
      let streamStarted = false;
      const { bridge, demo, audio, service } = await mountAssistant(t, {
        withAudio: true,
        electronAPI: {
          onToggleDictation: () => () => {},
          captureDictationTarget: () => {
            captureStarted = true;
            return target.promise;
          },
        },
        mockModules: {
          "/utils/visualFrame": `export const waitForVisualFrames = () => globalThis.__demoVisualFrames;`,
          "/helpers/audioManager": `export default class AudioManager {
          constructor() { this.sttConfig = { success: true }; }
          getState() { return {}; }
          setCallbacks() {}
          prepareMicCapture() {}
          cancelPreparedMicCapture() {}
          setVoiceAgentRequested() {}
          setAssistantSelectionContext() {}
          setTranslationRequested() {}
          beginSelectionCapture() {}
          shouldUseStreaming() { return false; }
          async startRecording() { return false; }
          cleanup() {}
        }`,
        },
      });
      t.mock.method(service, "processTextStreamingAI", async function* () {
        streamStarted = true;
        await old.promise;
        if (tail === "error")
          throw Object.assign(new Error("Expired old request"), { code: "AUTH_EXPIRED" });
        yield { type: "content", text: "Old content" };
      });
      const cancel = t.mock.method(service, "cancelActiveStream", () => {});
      bridge.begin("same-session");
      await React.act(async () => {
        await demo.run({ text: "Reply", attachment: null });
        await drain();
      });
      assert.equal(streamStarted, true);
      bridge.events.length = 0;
      let recording;
      await React.act(async () => {
        recording = audio.startRecording({ voiceAgentRequested: true });
        assert.equal(cancel.mock.callCount(), 1, "cancel occurs before the first await");
        assert.equal(bridge.events.at(-1).status, "preparing");
        assert.equal(bridge.events.at(-1).kind, "assistant");
      });
      assert.equal(captureStarted, false);
      if (boundary === "target") {
        await React.act(async () => {
          frames.resolve();
          await drain();
        });
        assert.equal(captureStarted, true);
      }
      await React.act(async () => {
        old.resolve();
        await drain();
      });
      assert.deepEqual(
        bridge.events.map((event) => event.status),
        ["preparing"]
      );
      await React.act(async () => {
        frames.resolve();
        target.resolve();
        assert.equal(await recording, false);
      });
      assert.equal(
        bridge.events.at(-1).status,
        "cancelled",
        "failed startup always settles preparing"
      );
    });
  }
}

for (const outcome of ["empty", "tool-only", "policy"]) {
  test(`${outcome} demo completion publishes exactly one recoverable fallback`, async (t) => {
    const { bridge, demo, service, policyStore } = await mountAssistant(t);
    if (outcome === "policy") policyStore.setState({ status: "loading" });
    t.mock.method(service, "processTextStreamingAI", async function* () {
      if (outcome === "tool-only")
        yield {
          type: "tool_calls",
          calls: [{ id: "tool", name: "search_notes", arguments: "{}" }],
        };
    });
    bridge.begin("fallback");
    await React.act(async () => {
      await demo.run({ text: "Reply", attachment: null });
      await drain();
    });
    const terminal = bridge.events.filter((event) => ["success", "error"].includes(event.status));
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].status, "error");
  });
}

test("Cloud agent missing auth headers emits AUTH_REQUIRED without making a request", async () => {
  const source = fs.readFileSync(require.resolve("../../src/helpers/ipcHandlers.js"), "utf8");
  const start = source.indexOf('    ipcMain.on("cloud-agent-stream-start",');
  const end = source.indexOf('    ipcMain.on("cloud-agent-stream-cancel",', start);
  assert.ok(start >= 0 && end > start);
  const AgentStreamRequestRegistry = require("../../src/helpers/agentStreamRequestRegistry");
  const { toPolicyFailure } = require("../../src/helpers/policyResponseError");
  const sent = [];
  let handler;
  vm.runInNewContext(`(function () { ${source.slice(start, end)} }).call(context)`, {
    context: { _agentStreamRequests: new AgentStreamRequestRegistry() },
    ipcMain: {
      on: (_channel, callback) => {
        handler = callback;
      },
    },
    getApiUrl: () => "https://unused.invalid",
    getAuthHeader: async () => ({}),
    proxyFetch: () => assert.fail("missing auth must not make a network request"),
    toPolicyFailure,
    debugLogger: { error() {} },
  });
  await handler(
    {
      sender: {
        id: 1,
        once() {},
        removeListener() {},
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    },
    "request",
    []
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "cloud-agent-stream-error");
  assert.equal(sent[0].payload.code, "AUTH_REQUIRED");
});
