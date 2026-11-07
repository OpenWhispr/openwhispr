const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("chat persistence awaits acknowledgment and rejects a deleted conversation", async (t) => {
  let finish;
  const writes = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        addAgentMessage: (...args) => {
          writes.push(args);
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { appendChatMessage } = await vite.ssrLoadModule("/components/chat/chatPersistence.ts");
  let settled = false;
  const save = appendChatMessage(12, "user", "bound question").then(() => {
    settled = true;
  });
  assert.equal(settled, false);
  assert.deepEqual(writes[0].slice(0, 3), [12, "user", "bound question"]);
  finish({ id: 1 });
  await save;
  const missing = appendChatMessage(12, "assistant", "answer");
  finish(null);
  await assert.rejects(missing);
});
