const test = require("node:test");
const assert = require("node:assert/strict");

const deliveryModule = import("../../src/helpers/assistantResponseDelivery.ts");
const RESPONSE = "Agent answer";
const PASTE_OPTIONS = {
  restoreClipboard: true,
  allowClipboardFallback: false,
};
const PASTE_DELIVERY = {
  mode: "paste",
  sessionId: "caret-session",
  ...PASTE_OPTIONS,
};

function createDeliveryHarness(pasteSuccess) {
  const pastes = [];
  const writes = [];

  return {
    pastes,
    writes,
    dependencies: {
      electronAPI: {
        async pasteAtCapturedTarget(sessionId, text, options) {
          pastes.push({ sessionId, text, options });
          return { success: pasteSuccess };
        },
        async writeClipboard(text) {
          writes.push(text);
          return { success: true };
        },
      },
      clipboard: { async writeText() {} },
    },
  };
}

test("Assistant delivery mode follows Auto-Paste and target state", async () => {
  const { createAssistantResponseDelivery } = await deliveryModule;
  const createDelivery = (autoPasteEnabled, deliverySessionId) =>
    createAssistantResponseDelivery({
      autoPasteEnabled,
      deliverySessionId,
      ...PASTE_OPTIONS,
    });

  assert.equal(createDelivery(false), null);
  assert.deepEqual(createDelivery(true), { mode: "clipboard" });
  assert.deepEqual(createDelivery(true, "caret-session"), PASTE_DELIVERY);
});

test("a captured Assistant target receives the response without replacing the clipboard", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, pastes, writes } = createDeliveryHarness(true);

  assert.deepEqual(await deliverAssistantResponse(PASTE_DELIVERY, RESPONSE, dependencies), {
    pasted: true,
    copied: false,
  });
  assert.deepEqual(pastes, [
    {
      sessionId: "caret-session",
      text: RESPONSE,
      options: PASTE_OPTIONS,
    },
  ]);
  assert.deepEqual(writes, []);
});

test("no Assistant target and a lost target both copy the completed response", async () => {
  const { deliverAssistantResponse } = await deliveryModule;

  for (const delivery of [{ mode: "clipboard" }, PASTE_DELIVERY]) {
    const { dependencies, writes } = createDeliveryHarness(false);

    assert.deepEqual(
      await deliverAssistantResponse(delivery, RESPONSE, dependencies),
      { pasted: false, copied: true },
      delivery.mode
    );
    assert.deepEqual(writes, [RESPONSE], delivery.mode);
  }
});
