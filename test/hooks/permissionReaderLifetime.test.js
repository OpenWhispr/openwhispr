const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const pending = (queue) => new Promise((resolve, reject) => queue.push({ resolve, reject }));
const DENIED_SCREEN = { granted: false, supported: true };
const GRANTED_SCREEN = { granted: true, supported: true };
const DENIED_AUDIO = { mode: "native", granted: false, status: "denied" };
const i18nMock = `const t = key => key; export const useTranslation = () => ({ t });`;

// Mounts `hook` under StrictMode reusing the test's root; returns the live state accessor.
const mountReader = (container, rootRef) => async (hook) => {
  let state;
  function Harness() {
    state = hook();
    return null;
  }
  if (!rootRef.current) rootRef.current = createRoot(container);
  const instance = rootRef.current;
  await React.act(async () =>
    instance.render(React.createElement(React.StrictMode, null, React.createElement(Harness)))
  );
  return () => state;
};

// One choreography over {mic, accessibility, screenContext, systemAudio}: newest grant wins, a failed re-check
// preserves the grant, and a cleaned-up owner never advances; flavor glue stays per flavor, steps written once.
test("permission reads cannot overwrite a newer grant or persist after cleanup", async (t) => {
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });
  const microphone = [];
  const accessibility = [];
  const screenChecks = [];
  const screenGrants = [];
  const audioChecks = [];
  const audioGrants = [];
  const counters = { opened: 0, tracksStopped: 0 };
  const { storage } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => "darwin",
        checkAccessibilityPermission: () => pending(accessibility),
        checkMicrophoneAccess: () => pending(microphone),
        openAccessibilitySettings: async () => (counters.opened++, { success: true }),
        checkScreenRecordingAccess: () => pending(screenChecks),
        requestScreenRecordingAccess: () => pending(screenGrants),
        checkSystemAudioAccess: () => pending(audioChecks),
        requestSystemAudioAccess: () => pending(audioGrants),
      },
    },
  });
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: () => counters.tracksStopped++ }] }),
      },
    },
  });
  const intervalBefore = globalThis.setInterval;
  const clearBefore = globalThis.clearInterval;
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  t.after(() => {
    globalThis.setInterval = intervalBefore;
    globalThis.clearInterval = clearBefore;
    if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore);
    else delete globalThis.navigator;
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-permission-readers-",
    noExternal: ["react-i18next"],
    mockModules: { "react-i18next": i18nMock },
  });
  const { usePermissions } = await vite.ssrLoadModule("/hooks/usePermissions.ts");
  const { useScreenRecordingPermission } = await vite.ssrLoadModule(
    "/hooks/useScreenRecordingPermission.ts"
  );
  const { useSystemAudioPermission } = await vite.ssrLoadModule(
    "/hooks/useSystemAudioPermission.ts"
  );
  const mount = mountReader(container, rootRef);
  // Freeze choreography: a request issued before cleanup resolves against the
  // dead owner and must not advance.
  const freezeOwner = async (hook, grants, grantedResult) => {
    let request;
    await React.act(async () => {
      request = hook().request();
    });
    await React.act(async () => {
      rootRef.current.unmount();
      rootRef.current = null;
    });
    grants[1].resolve(grantedResult);
    return request;
  };

  // mic: the reader request supersedes the mount-time revalidations.
  const mic = await mount(usePermissions);
  assert.equal(microphone.length, 2);
  await React.act(async () => mic().requestMicPermission());
  assert.equal(counters.tracksStopped, 1);
  await React.act(async () => {
    microphone[0].resolve({ granted: false });
    microphone[1].resolve({ granted: false });
  });
  assert.equal(storage.getItem("micPermissionGranted"), "true");

  // accessibility: newer read grants, obsolete one cannot undo it, and an in-flight request after
  // cleanup cannot persist denial. Fresh re-check pair on remount: [3] newer, [2] obsolete.
  const grants = await mount(usePermissions);
  await React.act(async () => accessibility[3].resolve(true));
  await React.act(async () => accessibility[2].resolve(false));
  assert.equal(storage.getItem("accessibilityPermissionGranted"), "true");
  let accessRequest;
  await React.act(async () => {
    accessRequest = grants().requestAccessibilityPermission();
  });
  await React.act(async () => {
    rootRef.current.unmount();
    rootRef.current = null;
  });
  await React.act(async () => accessibility[4].resolve(false));
  await accessRequest;
  assert.equal(counters.opened, 0, "an obsolete permission read cannot open Settings or persist denial");
  assert.equal(storage.getItem("accessibilityPermissionGranted"), "true");

  // screenContext: request supersedes both mount checks; a failed re-check keeps the grant.
  const screen = await mount(useScreenRecordingPermission);
  let screenRequest;
  await React.act(async () => {
    screenRequest = screen().request();
  });
  await React.act(async () => screenGrants[0].resolve(GRANTED_SCREEN));
  assert.equal(await screenRequest, true);
  await React.act(async () => {
    screenChecks[0].resolve(DENIED_SCREEN);
    screenChecks[1].resolve(DENIED_SCREEN);
  });
  assert.equal(screen().granted, true);
  let refresh;
  await React.act(async () => {
    refresh = screen().check();
  });
  await React.act(async () => screenChecks[2].reject(new Error("unavailable")));
  await refresh;
  assert.equal(screen().granted, true);
  screenRequest = await freezeOwner(screen, screenGrants, GRANTED_SCREEN);
  assert.equal(await screenRequest, false);

  // systemAudio: routine checks lose to the request; a failed re-check keeps the grant.
  const audio = await mount(useSystemAudioPermission);
  assert.equal(audioChecks.length, 2);
  await React.act(async () => audioChecks[1].resolve(DENIED_AUDIO));
  let oldCheck;
  await React.act(async () => {
    oldCheck = audio().check();
  });
  let audioRequest;
  await React.act(async () => {
    audioRequest = audio().request();
  });
  await React.act(async () =>
    audioGrants[0].resolve({ ...DENIED_AUDIO, granted: true, status: "granted" })
  );
  assert.equal(await audioRequest, true);
  await React.act(async () => {
    audioChecks[2].resolve(DENIED_AUDIO);
    audioChecks[0].resolve(DENIED_AUDIO);
  });
  await oldCheck;
  assert.equal(audio().granted, true);
  let failed;
  await React.act(async () => {
    failed = audio().check();
  });
  await React.act(async () => audioChecks[3].reject(new Error("unavailable")));
  await failed;
  assert.equal(audio().granted, true);
  assert.equal(audio().isChecking, false);
  const lateGrant = await freezeOwner(audio, audioGrants, { ...DENIED_AUDIO, granted: true });
  assert.equal(
    await lateGrant,
    false,
    "a cleaned-up onboarding owner cannot advance on a late grant"
  );
});

test("a poll tick during Grant still opens Accessibility settings", async (t) => {
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });
  const accessibility = [];
  let opened = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => "darwin",
        checkAccessibilityPermission: () => pending(accessibility),
        openAccessibilitySettings: async () => (opened++, { success: true }),
      },
    },
  });
  const ticks = [];
  const intervalBefore = globalThis.setInterval;
  const clearBefore = globalThis.clearInterval;
  globalThis.setInterval = (callback) => ticks.push(callback);
  globalThis.clearInterval = () => {};
  t.after(() => {
    globalThis.setInterval = intervalBefore;
    globalThis.clearInterval = clearBefore;
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-permission-grant-poll-",
    noExternal: ["react-i18next"],
    mockModules: { "react-i18next": i18nMock },
  });
  const { usePermissions } = await vite.ssrLoadModule("/hooks/usePermissions.ts");
  const state = await mountReader(container, rootRef)(usePermissions);
  await React.act(async () => accessibility.forEach((read) => read.resolve(false)));
  const grantRead = accessibility.length;
  let grant;
  await React.act(async () => {
    grant = state().requestAccessibilityPermission();
  });
  await React.act(async () => ticks.at(-1)());
  await React.act(async () => accessibility[grantRead].resolve(false));
  await grant;
  accessibility.at(-1).resolve(false);
  assert.equal(opened, 1, "the poll must not cancel the Grant click");
});

// Bespoke paste preservation: the mount revalidation cannot lose to an older read; a concurrent check keeps the latest answer.
test("paste tools stay live until a newer paste check wins", async (t) => {
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });
  const paste = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => "darwin",
        checkPasteTools: () => pending(paste),
      },
    },
  });
  const intervalBefore = globalThis.setInterval;
  const clearBefore = globalThis.clearInterval;
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  t.after(() => {
    globalThis.setInterval = intervalBefore;
    globalThis.clearInterval = clearBefore;
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-permission-preservers-",
    noExternal: ["react-i18next"],
    mockModules: { "react-i18next": i18nMock },
  });
  const { usePermissions } = await vite.ssrLoadModule("/hooks/usePermissions.ts");
  const mount = mountReader(container, rootRef);
  const state = await mount(usePermissions);
  await React.act(async () => {
    paste[1].resolve({ platform: "darwin", available: true, method: "fresh" });
    paste[0].resolve({ platform: "darwin", available: false, method: "old" });
  });
  assert.equal(state().pasteToolsInfo.method, "fresh");
  let first;
  let second;
  await React.act(async () => {
    first = state().checkPasteToolsAvailability();
    second = state().checkPasteToolsAvailability();
  });
  await React.act(async () =>
    paste[3].resolve({ platform: "darwin", available: true, method: "latest" })
  );
  await React.act(async () =>
    paste[2].resolve({ platform: "darwin", available: false, method: "obsolete" })
  );
  await Promise.all([first, second]);
  assert.equal(state().pasteToolsInfo.method, "latest");
});
