const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const blockedPolicy = {
  version: 1,
  transcription: { allowedModes: [], allowedByokProviders: [] },
  llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  features: { agentEnabled: false, webSearchEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: false,
  },
  minAppVersion: null,
};

test("an authorization change aborts an in-flight prepare and prevents stale reuse", async (t) => {
  const preparation = createDeferred();
  const prepareCalls = [];
  const abortCalls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: async (options) => {
          prepareCalls.push(options);
          if (prepareCalls.length === 1) return preparation.promise;
          return { success: true };
        },
        meetingTranscriptionAbort: async (sessionId) => {
          abortCalls.push(sessionId);
          return { success: true };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-authorization-boundary-test-",
  });
  const meeting = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });

  const firstPrepare = meeting.prepareTranscription();
  while (prepareCalls.length === 0) await Promise.resolve();
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.4",
    policy: blockedPolicy,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(abortCalls, [undefined]);
  preparation.resolve({ success: true });
  await firstPrepare;

  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });
  await Promise.resolve();
  abortCalls.length = 0;
  await meeting.prepareTranscription();
  assert.equal(prepareCalls.length, 2, "the stale prepared connection must not be reused");
});
