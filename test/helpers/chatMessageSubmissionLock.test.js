const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
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

test("message sender reports whether the submission lock accepted the send", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-message-sender-test-",
  });
  const { useChatMessageSender } = await vite.ssrLoadModule(
    "/components/chat/useChatMessageSender.ts"
  );

  let resolveCreate;
  const createConversation = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  const persistence = {
    messages: [],
    setMessages() {},
    async saveUserMessage() {},
  };
  const streaming = { async sendToAI() {} };
  let sendMessage;

  function Harness() {
    sendMessage = useChatMessageSender({
      conversationId: null,
      persistence,
      streaming,
      createConversation: async () => createConversation,
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  const first = sendMessage("first");
  const second = sendMessage("second");

  assert.equal(await second, false);
  resolveCreate(1);
  assert.equal(await first, true);
});

test("leaving a session while its message saves prevents inference and releases the send lock", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { useChatMessageSender } = await vite.ssrLoadModule(
    "/components/chat/useChatMessageSender.ts"
  );
  let version = 0;
  let releaseSave;
  let streams = 0;
  const persistence = {
    messages: [],
    getSessionVersion: () => version,
    setMessages() {},
    saveUserMessage: () =>
      new Promise((resolve) => {
        releaseSave = resolve;
      }),
  };
  let sendMessage;
  function Harness() {
    sendMessage = useChatMessageSender({
      conversationId: 1,
      persistence,
      streaming: {
        sendToAI: async () => {
          streams += 1;
        },
      },
      createConversation: async () => 1,
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  const first = sendMessage("Old request");
  version += 1;
  releaseSave();
  assert.equal(await first, false);
  assert.equal(streams, 0);
  const next = sendMessage("New request");
  releaseSave();
  assert.equal(await next, true);
  assert.equal(streams, 1);
});
