const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function installHookDom(t) {
  const originalDocument = globalThis.document;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const noop = () => {};
  class Element {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}
  const document = {
    nodeType: 9,
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
  };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    removeChild: noop,
    insertBefore: noop,
  };
  Object.assign(globalThis.window, {
    Element,
    HTMLElement,
    HTMLIFrameElement,
    document,
    getSelection: () => null,
  });
  document.defaultView = globalThis.window;
  document.documentElement = container;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });
  return container;
}

test("a voice draft cancels its request and discards a late result after authorization changes", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  globalThis.__voiceDraftAuthorizationCallbacks = new Set();
  t.after(() => delete globalThis.__voiceDraftAuthorizationCallbacks);
  const settings = {
    useLocalWhisper: false,
    whisperModel: "stale-whisper",
    localTranscriptionProvider: "nvidia",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionModel: "whisper-1",
    preferredLanguage: "en",
    transcriptionMode: "providers",
    remoteTranscriptionUrl: "",
    remoteTranscriptionModel: "",
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-draft-auth-boundary-test-",
    mockModules: {
      "/hooks/useAuth": "export const useAuth = () => ({ isSignedIn: true });",
      "/hooks/useSettings": `
        export const useSettings = () => globalThis.__voiceDraftSettings;
      `,
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__voiceDraftEffectiveSettings;
        export const useSettingsStore = (selector) => selector({
          cortiEnvironment: 'us',
          cortiTenant: 'base',
        });
      `,
      "/services/fileTranscription": `
        export const getTranscriptionApiKey = () => '';
        export const transcribeFile = (...args) => globalThis.__voiceDraftTranscribe(...args);
      `,
      managedLocalTranscriptionRuntime: `
        export const resolveManagedLocalTranscriptionRuntime = (config) => ({
          kind: 'ready', managed: false, settings: config,
        });
        export const isManagedLocalTranscriptionRuntimeAllowed = () => true;
      `,
      "/stores/policyStore": `
        export const usePolicyStore = { getState: () => ({}) };
      `,
      runtimeAuthorizationBoundary: `
        export const captureRuntimeAuthorizationLease = (_domains, onChanged) => {
          let current = true;
          const callback = () => {
            if (!current) return;
            current = false;
            onChanged();
          };
          globalThis.__voiceDraftAuthorizationCallbacks.add(callback);
          return {
            isCurrent: () => current,
            assertCurrent() {
              if (!current) throw Object.assign(new Error('Authorization changed'), {
                name: 'AbortError', code: 'AUTHORIZATION_BOUNDARY_CHANGED',
              });
            },
            dispose() { globalThis.__voiceDraftAuthorizationCallbacks.delete(callback); },
          };
        };
      `,
    },
  });
  globalThis.__voiceDraftSettings = settings;
  t.after(() => delete globalThis.__voiceDraftSettings);
  globalThis.__voiceDraftEffectiveSettings = {
    ...settings,
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    transcriptionMode: "local",
  };
  t.after(() => delete globalThis.__voiceDraftEffectiveSettings);

  let resolveTranscription;
  const pendingTranscription = new Promise((resolve) => {
    resolveTranscription = resolve;
  });
  const transcriptionCalls = [];
  globalThis.__voiceDraftTranscribe = (...args) => {
    transcriptionCalls.push(args);
    return pendingTranscription;
  };
  t.after(() => delete globalThis.__voiceDraftTranscribe);

  const cancelledRequests = [];
  Object.assign(globalThis.window.electronAPI, {
    saveTempAudio: async () => ({ path: "/tmp/voice-draft.webm" }),
    deleteTempAudio: async () => ({ success: true }),
    cancelUploadTranscription: async (requestId) => {
      cancelledRequests.push(requestId);
      return { success: true };
    },
  });

  const track = { stop() {} };
  const stream = { getTracks: () => [track] };
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });
  const originalAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = class {
    constructor() {
      this.destination = {};
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    createAnalyser() {
      return { fftSize: 0, connect() {}, getFloatTimeDomainData() {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    close() {
      return Promise.resolve();
    }
  };
  const originalMediaRecorder = globalThis.MediaRecorder;
  globalThis.MediaRecorder = class {
    constructor() {
      this.state = "inactive";
      this.ondataavailable = null;
      this.onstop = null;
    }
    start() {
      this.state = "recording";
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    }
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
  };
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
    if (originalMediaRecorder === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = originalMediaRecorder;
  });

  const transcripts = [];
  const errors = [];
  let voiceDraft;
  function Harness() {
    const { useVoiceDraft } = globalThis.__voiceDraftModule;
    voiceDraft = useVoiceDraft({
      onTranscript: (text) => transcripts.push(text),
      onError: (message) => errors.push(message),
    });
    return null;
  }
  globalThis.__voiceDraftModule = await vite.ssrLoadModule("/components/chat/useVoiceDraft.ts");
  t.after(() => delete globalThis.__voiceDraftModule);
  root = createRoot(container);

  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => voiceDraft.start());
  React.act(() => voiceDraft.stop());
  while (transcriptionCalls.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  React.act(() => {
    for (const callback of [...globalThis.__voiceDraftAuthorizationCallbacks]) callback();
  });
  resolveTranscription({ success: true, text: "late voice draft" });
  await React.act(async () => new Promise((resolve) => setImmediate(resolve)));

  const requestId = transcriptionCalls[0][3]?.requestId;
  assert.equal(typeof requestId, "string");
  assert.equal(transcriptionCalls[0][1].transcriptionMode, "local");
  assert.equal(transcriptionCalls[0][1].useLocalWhisper, true);
  assert.equal(transcriptionCalls[0][1].localTranscriptionProvider, "whisper");
  assert.equal(transcriptionCalls[0][1].whisperModel, "base");
  assert.deepEqual(cancelledRequests, [requestId]);
  assert.deepEqual(transcripts, []);
  assert.deepEqual(errors, []);
});
