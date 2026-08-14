const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const QUIET_MS = 250;
const CEILING_MS = 2000;
// setTimeout schedules on the monotonic clock and can fire while the Date.now()
// delta is still ~1ms short of the nominal delay, so lower bounds need slack.
const TIMER_SLACK_MS = 50;

async function loadManager(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settle-test-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => ({});
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": "export default { processText: async (t) => t };",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return Object.create(AudioManager.prototype);
}

async function elapsed(fn) {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}

test("settles on the quiet window when the transcript is already complete", async (t) => {
  const manager = await loadManager(t);

  const ms = await elapsed(() => manager.awaitStreamingTextSettled());

  assert.ok(ms >= QUIET_MS - TIMER_SLACK_MS, `settled too early: ${ms}ms`);
  assert.ok(ms < QUIET_MS + 150, `settled too late: ${ms}ms`);
});

test("waits out a slow tail instead of expiring on it", async (t) => {
  const manager = await loadManager(t);
  const lateFinalAt = 600;
  manager.streamingPartialText = "the last few words";
  setTimeout(() => {
    manager.streamingPartialText = "";
    manager.streamingTextBump?.();
  }, lateFinalAt);

  const ms = await elapsed(() => manager.awaitStreamingTextSettled());

  assert.ok(ms >= lateFinalAt + QUIET_MS - TIMER_SLACK_MS, `dropped the late tail: ${ms}ms`);
  assert.ok(ms < CEILING_MS, `should settle on quiet, not the ceiling: ${ms}ms`);
});

test("the ceiling bounds a final that never lands", async (t) => {
  const manager = await loadManager(t);
  manager.streamingPartialText = "never finalized";

  const ms = await elapsed(() => manager.awaitStreamingTextSettled());

  assert.ok(ms >= CEILING_MS - TIMER_SLACK_MS, `gave up too early: ${ms}ms`);
  assert.ok(ms < CEILING_MS + 300, `overran the ceiling: ${ms}ms`);
});

test("clears its timers so a settled wait leaves no handles behind", async (t) => {
  const manager = await loadManager(t);

  await manager.awaitStreamingTextSettled();

  assert.equal(manager.streamingTextBump, null);
  assert.equal(manager.streamingTextDebounce, null);
});
