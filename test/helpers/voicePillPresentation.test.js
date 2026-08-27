const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/voicePillPresentation.js");

test("Live Transcript stages footer growth, controls, then content", async () => {
  const { resolveLiveTranscriptEntrancePresentation } = await load();

  assert.deepEqual(resolveLiveTranscriptEntrancePresentation("encapsulate"), {
    coreStage: "encapsulated",
    controlsVisible: false,
    contentVisible: false,
  });
  assert.deepEqual(resolveLiveTranscriptEntrancePresentation("horizontal"), {
    coreStage: "footer",
    controlsVisible: false,
    contentVisible: false,
  });
  assert.deepEqual(resolveLiveTranscriptEntrancePresentation("controls"), {
    coreStage: "footer",
    controlsVisible: true,
    contentVisible: false,
  });
  assert.deepEqual(resolveLiveTranscriptEntrancePresentation("prepare"), {
    coreStage: "footer",
    controlsVisible: true,
    contentVisible: false,
  });
  assert.deepEqual(resolveLiveTranscriptEntrancePresentation("panel"), {
    coreStage: "content",
    controlsVisible: true,
    contentVisible: false,
  });
  assert.deepEqual(resolveLiveTranscriptEntrancePresentation("content"), {
    coreStage: "content",
    controlsVisible: true,
    contentVisible: true,
  });
});

test("Live Transcript entrance beats land strictly after one another", async () => {
  const { getLiveTranscriptEntranceTimeline } = await load();
  const timeline = getLiveTranscriptEntranceTimeline();

  // The invariant is the visual order, not the exact sums: the encapsulated
  // hold ends before the footer grows, controls appear before content is
  // prepared, and streaming starts only after the content settles.
  assert.ok(timeline.horizontalAtMs > 0);
  assert.ok(timeline.controlsAtMs > timeline.horizontalAtMs);
  assert.ok(timeline.prepareAtMs > timeline.controlsAtMs);
  assert.ok(timeline.panelAtMs > timeline.prepareAtMs);
  assert.ok(timeline.contentAtMs > timeline.panelAtMs);
  assert.ok(timeline.streamAtMs > timeline.contentAtMs);
});

test("Live Transcript keeps an adaptive surface instead of entering at Agent height", async () => {
  const { LIVE_TRANSCRIPT_SURFACE_LIMITS } = await load();

  assert.deepEqual(LIVE_TRANSCRIPT_SURFACE_LIMITS, {
    minHeight: 152,
    maxHeight: 538,
  });
  assert.ok(LIVE_TRANSCRIPT_SURFACE_LIMITS.minHeight < LIVE_TRANSCRIPT_SURFACE_LIMITS.maxHeight);
});

test("voice mode direction mirrors the right baseline only for bottom-left", async () => {
  const { resolveVoiceHorizontalDirection } = await load();

  assert.equal(resolveVoiceHorizontalDirection("bottom-right"), "right");
  assert.equal(resolveVoiceHorizontalDirection("bottom-left"), "left");
  assert.equal(resolveVoiceHorizontalDirection("center"), "right");
});

test("the speaking pill resolves right-origin modes onto one interpolable dock system", async () => {
  const { resolveVoicePillDock } = await load();

  assert.equal(
    resolveVoicePillDock({
      liveTranscriptOpen: true,
      liveTranscriptEntrancePhase: "horizontal",
      assistantOpen: false,
      panelStartPosition: "bottom-right",
    }),
    "live-transcript-bottom-left"
  );
  assert.equal(
    resolveVoicePillDock({
      liveTranscriptOpen: true,
      liveTranscriptEntrancePhase: "encapsulate",
      assistantOpen: false,
      panelStartPosition: "bottom-right",
    }),
    "live-transcript-encapsulated-bottom-right"
  );
  assert.equal(
    resolveVoicePillDock({
      liveTranscriptOpen: false,
      liveTranscriptEntrancePhase: "idle",
      assistantOpen: true,
      panelStartPosition: "bottom-right",
    }),
    "assistant-bottom-right"
  );
});

test("a left-origin session keeps the speaking pill left while surfaces grow right", async () => {
  const { resolveVoicePillDock } = await load();

  assert.equal(
    resolveVoicePillDock({
      liveTranscriptOpen: true,
      liveTranscriptEntrancePhase: "encapsulate",
      assistantOpen: false,
      panelStartPosition: "bottom-left",
    }),
    "live-transcript-encapsulated-bottom-left"
  );
  for (const liveTranscriptEntrancePhase of ["horizontal", "controls", "content"]) {
    assert.equal(
      resolveVoicePillDock({
        liveTranscriptOpen: true,
        liveTranscriptEntrancePhase,
        assistantOpen: false,
        panelStartPosition: "bottom-left",
      }),
      "live-transcript-bottom-left"
    );
  }
  assert.equal(
    resolveVoicePillDock({
      liveTranscriptOpen: false,
      liveTranscriptEntrancePhase: "idle",
      assistantOpen: true,
      panelStartPosition: "bottom-left",
    }),
    "assistant-bottom-left"
  );
});

test("the idle pill keeps its configured resting dock", async () => {
  const { resolveVoicePillDock } = await load();

  assert.equal(
    resolveVoicePillDock({
      liveTranscriptOpen: false,
      liveTranscriptEntrancePhase: "idle",
      assistantOpen: false,
      panelStartPosition: "center",
    }),
    "center"
  );
});

test("Live Transcript restores stop and cancel interactions without unlocking Assistant", async () => {
  const { resolveVoicePillInteraction } = await load();

  assert.deepEqual(
    resolveVoicePillInteraction({
      assistantMounted: false,
      liveTranscriptMounted: true,
      isRecording: true,
      isProcessing: false,
    }),
    { pillInteractive: true, cancelVisible: true }
  );
  assert.deepEqual(
    resolveVoicePillInteraction({
      assistantMounted: false,
      liveTranscriptMounted: true,
      isRecording: false,
      isProcessing: true,
    }),
    { pillInteractive: false, cancelVisible: true }
  );
  assert.deepEqual(
    resolveVoicePillInteraction({
      assistantMounted: true,
      liveTranscriptMounted: false,
      isRecording: false,
      isProcessing: true,
    }),
    { pillInteractive: false, cancelVisible: false }
  );
  // The bare pill (no Live Transcript) exposes discard on hover, as before the panel.
  assert.deepEqual(
    resolveVoicePillInteraction({
      assistantMounted: false,
      liveTranscriptMounted: false,
      isRecording: false,
      isProcessing: true,
      isHovered: true,
    }),
    { pillInteractive: true, cancelVisible: true }
  );
  assert.deepEqual(
    resolveVoicePillInteraction({
      assistantMounted: false,
      liveTranscriptMounted: false,
      isRecording: false,
      isProcessing: true,
      isHovered: false,
    }),
    { pillInteractive: true, cancelVisible: false }
  );
});

test("a mounted Live Transcript can stop after the floating pill was previously dragged", async () => {
  const { shouldActivateVoicePill } = await load();

  assert.equal(
    shouldActivateVoicePill({
      hasDragged: true,
      liveTranscriptMounted: true,
      isProcessing: false,
      isAgentThinking: false,
    }),
    true
  );
  assert.equal(
    shouldActivateVoicePill({
      hasDragged: true,
      liveTranscriptMounted: false,
      isProcessing: false,
      isAgentThinking: false,
    }),
    false
  );
});

test("the interactive pill recognizes standard keyboard activation keys", async () => {
  const { isVoicePillActivationKey } = await load();

  assert.equal(isVoicePillActivationKey("Enter"), true);
  assert.equal(isVoicePillActivationKey(" "), true);
  assert.equal(isVoicePillActivationKey("Escape"), false);
});

test("a collapsed completed transcript leaves the normal pill interaction available", async () => {
  const { resolveVoicePillInteraction } = await load();

  assert.deepEqual(
    resolveVoicePillInteraction({
      assistantMounted: false,
      liveTranscriptMounted: false,
      isRecording: false,
      isProcessing: false,
    }),
    { pillInteractive: true, cancelVisible: false }
  );
});

test("the actual window side overrides a stale edge preference", async () => {
  const { resolveVoicePillDock } = await load();

  assert.equal(
    resolveVoicePillDock({
      liveTranscriptOpen: false,
      liveTranscriptEntrancePhase: "idle",
      assistantOpen: false,
      panelStartPosition: "bottom-right",
      horizontalDirection: "left",
    }),
    "bottom-left"
  );
  assert.equal(
    resolveVoicePillDock({
      liveTranscriptOpen: false,
      liveTranscriptEntrancePhase: "idle",
      assistantOpen: false,
      panelStartPosition: "bottom-left",
      horizontalDirection: "right",
    }),
    "bottom-right"
  );
});

test("listening entrance starts in the thinking circle before expanding", async () => {
  const { resolveListeningEntrancePresentation } = await load();
  assert.deepEqual(resolveListeningEntrancePresentation({ isRecording: true, phase: "idle" }), {
    activeState: "recording",
    collapseToLogo: true,
    compactPill: false,
    waveformVisible: false,
  });
});

test("listening entrance expands before revealing the waveform", async () => {
  const { resolveListeningEntrancePresentation } = await load();
  assert.deepEqual(
    resolveListeningEntrancePresentation({ isRecording: true, phase: "expanding" }),
    {
      activeState: "recording",
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
    collapseToLogo: false,
    compactPill: true,
    waveformVisible: false,
  });
  assert.deepEqual(waveform, { ...settled, waveformVisible: true });
});

test("listening entrance timers preserve the visual order", async () => {
  const { getListeningEntranceTimeline } = await load();
  const timeline = getListeningEntranceTimeline();

  assert.ok(timeline.expandAtMs > 0);
  assert.ok(timeline.settleAtMs > timeline.expandAtMs);
  assert.ok(timeline.waveformAtMs > timeline.settleAtMs);
});

test("Agent footer retreats actions before the compact pill enters", async () => {
  const { getAssistantFooterTransitionTimeline, getListeningEntranceTimeline } = await load();
  const timeline = getAssistantFooterTransitionTimeline(false);

  assert.equal(timeline.initialPhase, "actions-exiting");
  assert.equal(timeline.handoffPhase, "pill-entering");
  assert.equal(timeline.settledPhase, "pill");
  assert.ok(timeline.handoffAtMs > 0);
  assert.ok(timeline.settledAtMs > timeline.handoffAtMs);
  // Cross-policy contract: the footer handoff must fully settle before the
  // listening entrance starts expanding the pill, or the two animations fight
  // over the same control.
  assert.ok(timeline.settledAtMs < getListeningEntranceTimeline().expandAtMs);
});

test("Agent footer retreats the pill before final actions grow from its anchor", async () => {
  const { getAssistantFooterTransitionTimeline } = await load();
  const timeline = getAssistantFooterTransitionTimeline(true);

  assert.equal(timeline.initialPhase, "pill-exiting");
  assert.equal(timeline.handoffPhase, "actions-entering");
  assert.equal(timeline.settledPhase, "actions");
  assert.ok(timeline.handoffAtMs > 0);
  assert.ok(timeline.settledAtMs > timeline.handoffAtMs);
});

test("Agent footer phases never mount actions and the pill together", async () => {
  const { resolveAssistantFooterPresentation } = await load();

  assert.deepEqual(resolveAssistantFooterPresentation("actions-exiting"), {
    pillVisible: false,
    actionsMounted: true,
    collapsePillToLogo: false,
  });
  assert.deepEqual(resolveAssistantFooterPresentation("pill-entering"), {
    pillVisible: true,
    actionsMounted: false,
    collapsePillToLogo: false,
  });
  assert.deepEqual(resolveAssistantFooterPresentation("pill-exiting"), {
    pillVisible: true,
    actionsMounted: false,
    collapsePillToLogo: true,
  });
});

test("an old Agent response stays ineligible during the follow-up handoff gap", async () => {
  const { resolveAssistantResponseReady } = await load();

  assert.equal(
    resolveAssistantResponseReady({
      responseContent: "The previous completed response",
      isBusy: false,
      isStreaming: false,
      voiceState: "idle",
      requestPending: true,
    }),
    false
  );
});

test("Agent response actions return only after the follow-up request settles", async () => {
  const { resolveAssistantResponseReady } = await load();
  const presentation = {
    responseContent: "The new completed response",
    isBusy: false,
    isStreaming: false,
    voiceState: "idle",
    requestPending: false,
  };

  assert.equal(resolveAssistantResponseReady(presentation), true);
  assert.equal(resolveAssistantResponseReady({ ...presentation, isBusy: true }), false);
  assert.equal(resolveAssistantResponseReady({ ...presentation, isStreaming: true }), false);
  assert.equal(resolveAssistantResponseReady({ ...presentation, voiceState: "listening" }), false);
});

test("stopping during the entrance cancels the staged recording presentation", async () => {
  const { resolveListeningEntrancePresentation } = await load();
  assert.deepEqual(
    resolveListeningEntrancePresentation({ isRecording: false, phase: "expanding" }),
    {
      activeState: null,
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

test("Agent identity follows active requests and the complete panel lifecycle", async () => {
  const { resolveAgentModeActive } = await load();

  assert.equal(
    resolveAgentModeActive({
      isAssistantVoice: true,
      isRecording: true,
      isProcessing: false,
      assistantPanelMounted: false,
    }),
    true
  );
  assert.equal(
    resolveAgentModeActive({
      isAssistantVoice: true,
      isRecording: false,
      isProcessing: true,
      assistantPanelMounted: false,
    }),
    true
  );
  assert.equal(
    resolveAgentModeActive({
      isAssistantVoice: false,
      isRecording: false,
      isProcessing: false,
      assistantPanelMounted: true,
    }),
    true
  );
  assert.equal(
    resolveAgentModeActive({
      isAssistantVoice: true,
      isRecording: false,
      isProcessing: false,
      assistantPanelMounted: false,
    }),
    false
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

test("one voice panel core hosts each expanded mode", async () => {
  const { resolveVoicePanelCorePresentation } = await load();

  assert.deepEqual(
    resolveVoicePanelCorePresentation({
      assistantOpen: true,
      assistantMounted: true,
      liveTranscriptOpen: false,
      liveTranscriptMounted: false,
    }),
    { mode: "assistant", open: true }
  );
  assert.deepEqual(
    resolveVoicePanelCorePresentation({
      assistantOpen: false,
      assistantMounted: false,
      liveTranscriptOpen: true,
      liveTranscriptMounted: true,
    }),
    { mode: "live-transcript", open: true }
  );
});

test("an opening mode outranks a sibling that is only finishing its exit", async () => {
  const { resolveVoicePanelCorePresentation } = await load();

  assert.deepEqual(
    resolveVoicePanelCorePresentation({
      assistantOpen: false,
      assistantMounted: true,
      liveTranscriptOpen: true,
      liveTranscriptMounted: true,
    }),
    { mode: "live-transcript", open: true }
  );
});

test("the voice panel core stays mounted but contentless while idle", async () => {
  const { resolveVoicePanelCorePresentation } = await load();

  assert.deepEqual(
    resolveVoicePanelCorePresentation({
      assistantOpen: false,
      assistantMounted: false,
      liveTranscriptOpen: false,
      liveTranscriptMounted: false,
    }),
    { mode: null, open: false }
  );
});

test("Live Transcript reopen belongs only to an active normal dictation", async () => {
  const { shouldOfferLiveTranscriptReopen } = await load();

  assert.equal(
    shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: true,
      isRecording: true,
      isProcessing: false,
      isAssistantVoice: false,
    }),
    true
  );
  assert.equal(
    shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: true,
      isRecording: false,
      isProcessing: true,
      isAssistantVoice: false,
    }),
    true
  );
  assert.equal(
    shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: true,
      isRecording: false,
      isProcessing: false,
      isAssistantVoice: false,
    }),
    false
  );
  assert.equal(
    shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: true,
      isRecording: true,
      isProcessing: false,
      isAssistantVoice: true,
    }),
    false
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

test("a collapsed transcript stays reopenable while its result is processing", async () => {
  const { resolveCompanionPillInteractive } = await load();

  assert.equal(
    resolveCompanionPillInteractive({
      mainProcessInteractive: true,
      surfaceInteractive: true,
      isProcessing: true,
      canReopenLiveTranscript: true,
    }),
    true
  );
  assert.equal(
    resolveCompanionPillInteractive({
      mainProcessInteractive: true,
      surfaceInteractive: true,
      isProcessing: true,
      canReopenLiveTranscript: false,
    }),
    false
  );
  assert.equal(
    resolveCompanionPillInteractive({
      mainProcessInteractive: false,
      surfaceInteractive: true,
      isProcessing: false,
      canReopenLiveTranscript: true,
    }),
    false
  );
  assert.equal(
    resolveCompanionPillInteractive({
      mainProcessInteractive: true,
      surfaceInteractive: false,
      isProcessing: false,
      canReopenLiveTranscript: false,
    }),
    false
  );
});

test("final Agent actions keep the idle pill hidden until the panel finishes closing", async () => {
  const { shouldSuppressPillForAssistantActions } = await load();

  assert.equal(
    shouldSuppressPillForAssistantActions({
      assistantOpen: true,
      footerPillVisible: false,
      assistantClosing: false,
      hasLiveActivity: false,
    }),
    true
  );
  assert.equal(
    shouldSuppressPillForAssistantActions({
      assistantOpen: true,
      footerPillVisible: false,
      assistantClosing: true,
      hasLiveActivity: false,
    }),
    true
  );
  assert.equal(
    shouldSuppressPillForAssistantActions({
      assistantOpen: true,
      footerPillVisible: true,
      assistantClosing: false,
      hasLiveActivity: false,
    }),
    false
  );
  assert.equal(
    shouldSuppressPillForAssistantActions({
      assistantOpen: false,
      footerPillVisible: false,
      assistantClosing: false,
      hasLiveActivity: true,
    }),
    false
  );
});

test("activity handed back at close intent stays visible through the content fade", async () => {
  const { shouldSuppressPillForAssistantActions } = await load();

  // The companion hides at close INTENT while `assistantOpen` stays true until
  // the fade completes: suppressing here is the both-hidden gap.
  assert.equal(
    shouldSuppressPillForAssistantActions({
      assistantOpen: true,
      footerPillVisible: false,
      assistantClosing: true,
      hasLiveActivity: true,
    }),
    false
  );
  // Before close intent the footer still owns the visuals, so a companion
  // recording must not surface a second pill here.
  assert.equal(
    shouldSuppressPillForAssistantActions({
      assistantOpen: true,
      footerPillVisible: false,
      assistantClosing: false,
      hasLiveActivity: true,
    }),
    true
  );
});
