const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/voicePillPresentation.js");

test("Agent listening keeps the existing expanded recording pill", async () => {
  const { resolveVoiceActivityPresentation } = await load();
  assert.deepEqual(
    resolveVoiceActivityPresentation({
      isRecording: true,
      isProcessing: false,
      isAssistantVoice: true,
      assistantThinking: false,
    }),
    { activeState: "recording", compactPill: true, isAgentThinking: false }
  );
});

test("Agent transcription contracts to the rotating thinking circle", async () => {
  const { resolveVoiceActivityPresentation } = await load();
  assert.deepEqual(
    resolveVoiceActivityPresentation({
      isRecording: false,
      isProcessing: true,
      isAssistantVoice: true,
      assistantThinking: false,
    }),
    { activeState: "thinking", compactPill: false, isAgentThinking: true }
  );
});

test("model thinking stays in the rotating circle after transcription ends", async () => {
  const { resolveVoiceActivityPresentation } = await load();
  assert.deepEqual(
    resolveVoiceActivityPresentation({
      isRecording: false,
      isProcessing: false,
      isAssistantVoice: false,
      assistantThinking: true,
    }),
    { activeState: "thinking", compactPill: false, isAgentThinking: true }
  );
});

test("regular dictation transcription contracts to the rotating thinking circle", async () => {
  const { resolveVoiceActivityPresentation } = await load();
  assert.deepEqual(
    resolveVoiceActivityPresentation({
      isRecording: false,
      isProcessing: true,
      isAssistantVoice: false,
      assistantThinking: false,
    }),
    { activeState: "thinking", compactPill: false, isAgentThinking: false }
  );
});

test("a fresh Agent request thinks in the floating logo circle", async () => {
  const { resolveAssistantThinkingTransition } = await load();
  assert.deepEqual(resolveAssistantThinkingTransition(false), {
    panelOpen: false,
    panelMounted: true,
    responseReady: false,
    thinking: true,
  });
});

test("an Agent follow-up keeps the existing response modal open while thinking", async () => {
  const { resolveAssistantThinkingTransition } = await load();
  assert.deepEqual(resolveAssistantThinkingTransition(true), {
    panelOpen: true,
    panelMounted: true,
    responseReady: false,
    thinking: true,
  });
});
