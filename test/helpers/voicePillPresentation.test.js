const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/voicePillPresentation.js");

test("listening entrance starts in the thinking circle before expanding", async () => {
  const { resolveListeningEntrancePresentation } = await load();
  assert.deepEqual(
    resolveListeningEntrancePresentation({ isRecording: true, phase: "idle" }),
    {
      activeState: "recording",
      beamActive: true,
      collapseToLogo: true,
      compactPill: false,
      waveformVisible: false,
    }
  );
});

test("listening entrance expands before revealing the waveform", async () => {
  const { resolveListeningEntrancePresentation } = await load();
  assert.deepEqual(
    resolveListeningEntrancePresentation({ isRecording: true, phase: "expanding" }),
    {
      activeState: "recording",
      beamActive: false,
      collapseToLogo: false,
      compactPill: true,
      waveformVisible: false,
    }
  );
});

test("listening entrance settles at full width before revealing the waveform", async () => {
  const { resolveListeningEntrancePresentation } = await load();
  const settled = resolveListeningEntrancePresentation({
    isRecording: true,
    phase: "settled",
  });
  const waveform = resolveListeningEntrancePresentation({
    isRecording: true,
    phase: "waveform",
  });

  assert.deepEqual(settled, {
    activeState: "recording",
    beamActive: false,
    collapseToLogo: false,
    compactPill: true,
    waveformVisible: false,
  });
  assert.deepEqual(waveform, { ...settled, waveformVisible: true });
});

test("listening entrance reveals the recording waveform last", async () => {
  const { resolveListeningEntrancePresentation } = await load();
  assert.deepEqual(
    resolveListeningEntrancePresentation({ isRecording: true, phase: "waveform" }),
    {
      activeState: "recording",
      beamActive: false,
      collapseToLogo: false,
      compactPill: true,
      waveformVisible: true,
    }
  );
});

test("listening entrance timers preserve the visual order", async () => {
  const { getListeningEntranceTimeline, LISTENING_ENTRANCE_TIMING } = await load();
  const timeline = getListeningEntranceTimeline();
  assert.ok(LISTENING_ENTRANCE_TIMING.thinkingMs > 0);
  assert.ok(LISTENING_ENTRANCE_TIMING.expansionMs > 0);
  assert.ok(LISTENING_ENTRANCE_TIMING.waveformDelayMs > 0);
  assert.equal(timeline.expandAtMs, LISTENING_ENTRANCE_TIMING.thinkingMs);
  assert.equal(
    timeline.settleAtMs,
    timeline.expandAtMs + LISTENING_ENTRANCE_TIMING.expansionMs
  );
  assert.equal(
    timeline.waveformAtMs,
    timeline.settleAtMs + LISTENING_ENTRANCE_TIMING.waveformDelayMs
  );
});

test("stopping during the entrance cancels the staged recording presentation", async () => {
  const { resolveListeningEntrancePresentation } = await load();
  assert.deepEqual(
    resolveListeningEntrancePresentation({ isRecording: false, phase: "expanding" }),
    {
      activeState: null,
      beamActive: null,
      collapseToLogo: false,
      compactPill: false,
      waveformVisible: true,
    }
  );
});

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
