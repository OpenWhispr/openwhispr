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
