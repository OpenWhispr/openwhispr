const test = require("node:test");
const assert = require("node:assert/strict");

test("Auto-Paste copies an Assistant response when no writable input is selected", async () => {
  const { createAssistantResponseDelivery, deliverAssistantResponse } =
    await import("../../src/helpers/assistantResponseDelivery.ts");
  const writes = [];
  const delivery = createAssistantResponseDelivery({
    autoPasteEnabled: true,
    deliverySessionId: undefined,
    restoreClipboard: true,
    allowClipboardFallback: false,
  });

  assert.deepEqual(delivery, { mode: "clipboard" });
  assert.deepEqual(
    await deliverAssistantResponse(delivery, "Agent answer", {
      electronAPI: {
        async writeClipboard(text) {
          writes.push(text);
          return { success: true };
        },
      },
      clipboard: { async writeText() {} },
    }),
    { pasted: false, copied: true }
  );
  assert.deepEqual(writes, ["Agent answer"]);
});

test("a captured Assistant target receives the response without replacing the clipboard", async () => {
  const { createAssistantResponseDelivery, deliverAssistantResponse } =
    await import("../../src/helpers/assistantResponseDelivery.ts");
  const pastes = [];
  const writes = [];
  const delivery = createAssistantResponseDelivery({
    autoPasteEnabled: true,
    deliverySessionId: "caret-session",
    restoreClipboard: true,
    allowClipboardFallback: false,
  });

  assert.deepEqual(
    await deliverAssistantResponse(delivery, "Agent answer", {
      electronAPI: {
        async pasteAtCapturedTarget(sessionId, text, options) {
          pastes.push({ sessionId, text, options });
          return { success: true };
        },
        async writeClipboard(text) {
          writes.push(text);
          return { success: true };
        },
      },
      clipboard: { async writeText() {} },
    }),
    { pasted: true, copied: false }
  );
  assert.deepEqual(pastes, [
    {
      sessionId: "caret-session",
      text: "Agent answer",
      options: { restoreClipboard: true, allowClipboardFallback: false },
    },
  ]);
  assert.deepEqual(writes, []);
});

test("a lost Assistant target falls back to copying the completed response", async () => {
  const { createAssistantResponseDelivery, deliverAssistantResponse } =
    await import("../../src/helpers/assistantResponseDelivery.ts");
  const writes = [];
  const delivery = createAssistantResponseDelivery({
    autoPasteEnabled: true,
    deliverySessionId: "caret-session",
    restoreClipboard: true,
    allowClipboardFallback: false,
  });

  assert.deepEqual(
    await deliverAssistantResponse(delivery, "Agent answer", {
      electronAPI: {
        async pasteAtCapturedTarget() {
          return { success: false };
        },
        async writeClipboard(text) {
          writes.push(text);
          return { success: true };
        },
      },
      clipboard: { async writeText() {} },
    }),
    { pasted: false, copied: true }
  );
  assert.deepEqual(writes, ["Agent answer"]);
});

test("disabling Auto-Paste leaves Assistant delivery panel-only", async () => {
  const { createAssistantResponseDelivery } =
    await import("../../src/helpers/assistantResponseDelivery.ts");

  assert.equal(
    createAssistantResponseDelivery({
      autoPasteEnabled: false,
      deliverySessionId: undefined,
      restoreClipboard: true,
      allowClipboardFallback: false,
    }),
    null
  );
});
