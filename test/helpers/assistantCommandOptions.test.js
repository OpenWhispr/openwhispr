const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/dictation/assistantCommandOptions.ts");

const PASTE = {
  mode: "paste",
  sessionId: "s",
  restoreClipboard: true,
  allowClipboardFallback: false,
};
// Keep Transcription in Clipboard on: the caret delivery may leave the answer there.
const PASTE_KEEPING_ANSWER = { ...PASTE, restoreClipboard: false };

function handlers(deliverResult = { pasted: true, copied: false }) {
  const calls = { opened: 0, delivered: [], copied: [] };
  return {
    calls,
    value: {
      onResponseContent: () => {
        calls.opened += 1;
      },
      deliver: async (delivery, content) => {
        calls.delivered.push({ delivery, content });
        return delivery.mode === "paste" ? deliverResult : { pasted: false, copied: true };
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
    { attachment: null, selectedContext: null, delivery: PASTE_KEEPING_ANSWER },
    h.value
  );

  built.options.onApprovalRequested();
  await built.options.onComplete({ assistantId: "a", content: "Posted to #eng" });

  assert.equal(h.calls.opened, 1);
  assert.deepEqual(h.calls.delivered, [
    { delivery: { mode: "clipboard" }, content: "Posted to #eng" },
  ]);
  assert.equal(built.wasDelivered(), false);
});

test("a held answer stays in the panel and is copied instead of pasted", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  for (const delivery of [PASTE_KEEPING_ANSWER, { mode: "clipboard" }]) {
    const h = handlers();
    const built = buildAssistantCommandSendOptions(
      { attachment: null, selectedContext: null, delivery },
      h.value
    );

    built.options.onHoldDelivery();
    await built.options.onComplete({ assistantId: "a", content: "Dana is dana@example.com." });

    assert.equal(h.calls.opened, 1, delivery.mode);
    assert.deepEqual(
      h.calls.delivered,
      [{ delivery: { mode: "clipboard" }, content: "Dana is dana@example.com." }],
      delivery.mode
    );
    assert.deepEqual(h.calls.copied, ["Dana is dana@example.com."], delivery.mode);
    assert.equal(built.wasDelivered(), false, delivery.mode);
  }
});

test("a held caret answer leaves the clipboard alone when the delivery would restore it", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  for (const hold of ["onHoldDelivery", "onApprovalRequested"]) {
    const h = handlers();
    const built = buildAssistantCommandSendOptions(
      { attachment: null, selectedContext: null, delivery: PASTE },
      h.value
    );

    built.options[hold]();
    await built.options.onComplete({ assistantId: "a", content: "Which Dana did you mean?" });

    assert.equal(h.calls.opened, 1, hold);
    assert.equal(h.calls.delivered.length, 0, hold);
    assert.equal(h.calls.copied.length, 0, hold);
    assert.equal(built.wasDelivered(), false, hold);
  }
});

test("the command's screenshot and selection ride along with the send", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  const attachment = { image: "base64", mediaType: "image/jpeg" };
  const selectedContext = { text: "selected words", sourceMessageId: "m1" };
  for (const delivery of [PASTE, { mode: "clipboard" }, null]) {
    const built = buildAssistantCommandSendOptions(
      { attachment, selectedContext, delivery },
      handlers().value
    );

    assert.equal(built.options.attachment, attachment);
    assert.equal(built.options.selectedContext, selectedContext);
  }
});

test("a hold that preserves the clipboard neither pastes nor copies", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  for (const delivery of [PASTE, { mode: "clipboard" }]) {
    const h = handlers();
    const built = buildAssistantCommandSendOptions(
      { attachment: null, selectedContext: null, delivery },
      h.value
    );

    // A later plain hold in the same turn must not undo the preserve.
    built.options.onHoldDelivery({ preserveClipboard: true });
    built.options.onHoldDelivery();
    await built.options.onComplete({ assistantId: "a", content: "Draft opened; paste the body." });

    assert.equal(h.calls.delivered.length, 0, delivery.mode);
    assert.equal(h.calls.copied.length, 0, delivery.mode);
    assert.equal(built.wasDelivered(), false, delivery.mode);
  }
});

test("a caret answer that falls back to the clipboard confirms the copy", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  const h = handlers({ pasted: false, copied: true });
  const built = buildAssistantCommandSendOptions(
    { attachment: null, selectedContext: null, delivery: PASTE },
    h.value
  );

  await built.options.onComplete({ assistantId: "a", content: "Answer" });

  assert.deepEqual(h.calls.copied, ["Answer"]);
  assert.equal(built.wasDelivered(), false);
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
