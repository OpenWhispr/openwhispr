const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("meetingRecordingStore still loads under the renderer harness after the reducer extraction", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-store-import-test-",
  });

  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const reducer = await vite.ssrLoadModule("/stores/meetingSegmentReducer.ts");

  assert.equal(typeof store.startRecording, "function");
  assert.equal(typeof store.useMeetingRecordingStore?.getState, "function");
  assert.equal(typeof reducer.reduceMeetingSegmentEvent, "function");
  const initial = store.useMeetingRecordingStore.getState();
  assert.deepEqual(initial.segments, []);
  assert.equal(initial.micPartial, "");
  assert.equal(initial.systemPartial, "");
});

test("personal meeting options preserve manual enterprise preference while required profiles retain precedence", async (t) => {
  const calls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: async (options) => {
          calls.push(options);
          return { success: false };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-manual-enterprise-",
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { prepareTranscription } = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  usePolicyStore.setState({ accountId: "account-a", authGeneration: 1 });
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-a" });
  const record = {
    provider: "openai-compatible",
    mode: "managed_default",
    allowManualSetup: true,
    version: 1,
    config: { realtime: { defaultDeployment: "company-speech" } },
  };
  for (const [setupMode, mode, expectedProvider] of [
    ["manual", "managed_default", "local"],
    ["auto", "managed_default", "enterprise-realtime"],
    ["manual", "managed_required", "enterprise-realtime"],
  ]) {
    useSettingsStore.setState({
      meetingFollowsTranscription: false,
      meetingTranscriptionMode: "local",
      enterpriseTranscriptionSetupMode: setupMode,
    });
    useEnterpriseIdentityStore.setState({
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 1,
      status: "ready",
      config: { generation: 1, providers: [{ ...record, mode }] },
    });
    await prepareTranscription();
    const options = calls.at(-1);
    assert.equal(options.provider, expectedProvider);
    assert.equal(options.managedContext?.setupMode ?? options.enterpriseSetupMode, setupMode);
    assert.equal(options.enterpriseIdentity.workspaceId, "workspace-a");
  }
});
