const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Regression coverage for the empty-response fallback in useChatStreaming.ts:
// `sendToAI` must not report a stream cancelled before any visible token as a
// genuine (if empty) completion, or the fabricated "no response" text gets
// persisted into the user's conversation history as if the model said it.
//
// `isSendGenerationStale` is the exported pure predicate the hook's
// `cancelled()` closure delegates to (`cancelled = () =>
// isSendGenerationStale(sendGeneration, sendGenerationRef.current)`). The
// hook itself can't be exercised end-to-end here: this repo's test harness
// only supports Vite-SSR module loading (`ssrLoadModule`) plus one-shot,
// non-interactive `react-dom/server` rendering (see
// `test/lib/rendererTestHarness.js` and `test/helpers/harness/reactSsr.js`)
// — there is no jsdom, no `@testing-library/react`, and no `act`, so a
// `useCallback`-returned async function can't be invoked and its subsequent
// `setState` effects observed the way `sendToAI` needs. `assistantPanel.test.js`
// hits the same wall and stubs `useChatStreaming` out entirely rather than
// exercising it. This test instead covers the guard at the closest seam that
// really is testable: the real, exported comparison the hook's cancellation
// check runs on.
async function loadIsSendGenerationStale(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-send-generation-test-",
  });
  const { isSendGenerationStale } = await vite.ssrLoadModule(
    "/components/chat/useChatStreaming.ts"
  );
  // useChatStreaming.ts imports ReasoningService.ts, whose default export is
  // a singleton constructed at import time; its API-key cache starts a real
  // setInterval that otherwise keeps the process alive after the test ends
  // (the same cleanup reasoningServiceStreamingThink.test.js's
  // loadReasoningService performs for the same reason).
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  return isSendGenerationStale;
}

test("a send that completes without an intervening cancelStream() is not stale", async (t) => {
  const isSendGenerationStale = await loadIsSendGenerationStale(t);

  // sendToAI captured generation 1 at the start of the call; nothing bumped
  // sendGenerationRef in between, so the ref is still 1 when the stream ends
  // with no visible token — a genuine empty completion. The fallback must run.
  assert.equal(isSendGenerationStale(1, 1), false);
});

test("cancelStream() between a send's start and its end marks that send stale", async (t) => {
  const isSendGenerationStale = await loadIsSendGenerationStale(t);

  // sendToAI captured generation 1; the user pressed Esc (or Stop) before any
  // visible token arrived, so cancelStream() bumped sendGenerationRef to 2
  // before the loop exited. The fallback must be suppressed — this send is
  // not a genuine empty completion, it was cut short.
  assert.equal(isSendGenerationStale(1, 2), true);
});
