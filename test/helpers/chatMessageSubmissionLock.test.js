const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("message submission lock rejects a rapid second send until conversation creation settles", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-submission-lock-test-",
  });
  const { createMessageSubmissionLock } = await vite.ssrLoadModule(
    "/components/chat/useChatMessageSender.ts"
  );
  const lock = createMessageSubmissionLock();
  let resolveCreate;
  let createCalls = 0;
  const createConversation = new Promise((resolve) => {
    resolveCreate = resolve;
  });

  const first = lock.run(async () => {
    createCalls += 1;
    await createConversation;
  });
  const second = lock.run(async () => {
    createCalls += 1;
  });

  assert.equal(await second, false);
  assert.equal(createCalls, 1);
  resolveCreate();
  assert.equal(await first, true);
  assert.equal(await lock.run(async () => {}), true);
});
