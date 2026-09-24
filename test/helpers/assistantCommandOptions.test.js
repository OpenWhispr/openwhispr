const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/dictation/assistantCommandOptions.ts");

const PASTE = { mode: "paste", sessionId: "s", restoreClipboard: true, allowClipboardFallback: false };

function handlers() {
  const calls = { opened: 0, delivered: [], copied: [] };
  return {
    calls,
    value: {
      onResponseContent: () => {
        calls.opened += 1;
      },
      deliver: async (delivery, content) => {
        calls.delivered.push({ delivery, content });
        return { pasted: true, copied: false };
      },
      confirmCopied: (content) => calls.copied.push(content),
    },
  };
}

test("a caret-delivered command pastes its answer when no approval was needed", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  const h = handlers();
  const built = buildAssistantCommandSendOptions(
    { attachment: null, selectedContext: null, delivery: PASTE },
    h.value
  );

  assert.equal(built.options.suppressResponseContent, true);
  await built.options.onComplete({ assistantId: "a", content: "Answer" });

  assert.equal(h.calls.delivered.length, 1);
  assert.equal(built.wasDelivered(), true);
});

test("an approval opens the hidden panel and cancels caret delivery", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  const h = handlers();
  const built = buildAssistantCommandSendOptions(
    { attachment: null, selectedContext: null, delivery: PASTE },
    h.value
  );

  built.options.onApprovalRequested();
  await built.options.onComplete({ assistantId: "a", content: "Posted to #eng" });

  assert.equal(h.calls.opened, 1);
  assert.equal(h.calls.delivered.length, 0);
  assert.equal(built.wasDelivered(), false);
});

test("a tool that holds delivery keeps the answer in the panel: no paste or copy", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  for (const delivery of [PASTE, { mode: "clipboard" }]) {
    const h = handlers();
    const built = buildAssistantCommandSendOptions(
      { attachment: null, selectedContext: null, delivery },
      h.value
    );

    built.options.onHoldDelivery();
    await built.options.onComplete({ assistantId: "a", content: "Draft opened; paste the body." });

    assert.equal(h.calls.opened, 1, delivery.mode);
    assert.equal(h.calls.delivered.length, 0, delivery.mode);
    assert.equal(built.wasDelivered(), false, delivery.mode);
  }
});

test("a panel command still opens for an approval and has no delivery hook", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  const h = handlers();
  const built = buildAssistantCommandSendOptions(
    { attachment: null, selectedContext: null, delivery: null },
    h.value
  );

  assert.equal(built.options.onComplete, undefined);
  assert.equal(built.options.suppressResponseContent, false);
  built.options.onApprovalRequested();
  assert.equal(h.calls.opened, 1);
});
