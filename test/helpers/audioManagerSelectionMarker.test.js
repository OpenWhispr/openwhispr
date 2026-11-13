const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const selectedText = "The team meeting is on Tuesday at 10 AM in room 4.";
const replacement = "The team meeting is on Wednesday at 10 AM in room 4.";
const instruction = "It moved to Wednesday";

function requestMarker(config) {
  const match = config.systemPrompt.match(/append this exact completion marker[^\n]+: ([^\n]+)$/);
  assert.ok(match, "the production request must include a completion marker");
  const marker = match[1];
  assert.match(
    marker,
    /^__OPENWHISPR_SELECTION_COMPLETE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:__)?$/
  );
  assert.equal(config.requireCompleteOutput, true);
  return marker;
}

// Only the provider response is scripted; processAgentCommand generates the
// nonce, builds the real request and invokes the real strict response parser.
test("selection completion nonce survives omitted decoration and stays strict", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-selection-marker-test-",
    settingsKey: "__selectionMarkerSettings",
  });
  function managerFor(response, spokenInstruction = instruction) {
    return createManager({
      isProcessing: true,
      pendingAssistantConversation: null,
      consumeSelectionCapture: async () => ({
        status: "selected",
        text: selectedText,
        sessionId: "synthetic-selection",
      }),
      processWithReasoningModel: async (text, _model, _agent, config) => {
        assert.deepEqual(JSON.parse(text), { spokenInstruction, selectedText });
        return response(requestMarker(config));
      },
    });
  }
  const run = (manager, spokenInstruction = instruction) =>
    manager.processAgentCommand(spokenInstruction, "synthetic-model", "Assistant", {
      provider: "openai",
      systemPrompt: "Synthetic editing prompt",
      selectionEditReachable: true,
    });

  await t.test("a complete response still arms only the captured selection", async () => {
    const manager = managerFor((marker) => `${replacement}${marker}`);
    assert.equal(await run(manager), replacement);
    assert.deepEqual(manager.pendingSelectionEdit, { sessionId: "synthetic-selection" });
  });

  await t.test("the reported reply without closing underscores is accepted", async () => {
    const manager = managerFor((marker) => `${replacement}${marker.replace(/__$/, "")}`);
    assert.equal(await run(manager), replacement);
    assert.deepEqual(manager.pendingSelectionEdit, { sessionId: "synthetic-selection" });
  });

  for (const [name, response] of [
    [
      "wrong UUID",
      (marker) => {
        const stem = marker.replace(/__$/, "");
        return `${replacement}${stem.slice(0, -1)}${stem.endsWith("a") ? "b" : "a"}${marker.endsWith("__") ? "__" : ""}`;
      },
    ],
    [
      "partial UUID",
      (marker) =>
        `${replacement}${marker.replace(/__$/, "").slice(0, -1)}${marker.endsWith("__") ? "__" : ""}`,
    ],
    ["missing marker", () => replacement],
    ["trailing content", (marker) => `${replacement}${marker} explanation`],
    ["trailing newline", (marker) => `${replacement}${marker}\n`],
    ["duplicate marker", (marker) => `${replacement}${marker}${marker}`],
  ]) {
    await t.test(`rejects ${name}`, async () => {
      const manager = managerFor(response);
      await assert.rejects(run(manager), { code: "SELECTION_EDIT_INVALID_RESPONSE" });
      assert.ok(!manager.pendingSelectionEdit);
    });
  }

  // Cloud refuses a rewrite cut off at the length limit itself, so its vision
  // chain's answer without the marker is complete; a partial, wrong or
  // misplaced one still isn't, and text-only Cloud keeps the marker.
  const runCloud = (manager, screenContext = { data: "img", mediaType: "image/jpeg" }) =>
    manager.processAgentCommand(instruction, "synthetic-model", "Assistant", {
      provider: "openwhispr",
      systemPrompt: "Synthetic editing prompt",
      selectionEditReachable: true,
      ...(screenContext ? { screenContext } : {}),
    });
  await t.test("Cloud accepts a complete screenshot rewrite without the marker", async () => {
    const manager = managerFor(() => replacement);
    assert.equal(await runCloud(manager), replacement);
    assert.deepEqual(manager.pendingSelectionEdit, { sessionId: "synthetic-selection" });
  });
  await t.test("text-only Cloud still rejects an answer without the marker", async () => {
    const manager = managerFor(() => replacement);
    await assert.rejects(runCloud(manager, null), { code: "SELECTION_EDIT_INVALID_RESPONSE" });
    assert.ok(!manager.pendingSelectionEdit);
  });
  for (const [name, response] of [
    ["partial UUID", (marker) => `${replacement}${marker.slice(0, -1)}`],
    ["trailing content", (marker) => `${replacement}${marker} explanation`],
    ["duplicate marker", (marker) => `${replacement}${marker}${marker}`],
  ]) {
    await t.test(`Cloud still rejects ${name}`, async () => {
      const manager = managerFor(response);
      await assert.rejects(runCloud(manager), { code: "SELECTION_EDIT_INVALID_RESPONSE" });
      assert.ok(!manager.pendingSelectionEdit);
    });
  }

  await t.test("an empty replacement cannot arm an edit", async () => {
    const manager = managerFor((marker) => marker);
    await assert.rejects(run(manager), { code: "SELECTION_EDIT_EMPTY_RESPONSE" });
    assert.ok(!manager.pendingSelectionEdit);
  });

  await t.test("a question verdict with omitted decoration goes to the panel", async () => {
    const { SELECTION_QUESTION_MARKER } = await import("../../src/helpers/selectionEditing.js");
    const question = "Explain this";
    const manager = managerFor(
      (marker) => `${SELECTION_QUESTION_MARKER}${marker.replace(/__$/, "")}`,
      question
    );
    assert.equal(await run(manager, question), question);
    assert.ok(!manager.pendingSelectionEdit);
    assert.equal(manager.pendingAssistantConversation.selectedContext.text, selectedText);
  });
});
