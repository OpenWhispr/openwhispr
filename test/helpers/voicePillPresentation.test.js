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

// resolveVoicePillTravelPresentation: how long the persistent pill takes to
// glide to its next dock, and on what easing. The Assistant panel's shell
// springs open on the pinned morph spring (Task 4); the pill's travel plays
// the SAME spring so it arrives at the footer as the shell finishes. Live
// Transcript's entrance is out of scope here and must keep its own
// established timings and the transition's default CSS easing (no override).
test("the pill travels on the morph spring, at the morph duration, while the Assistant panel is mounted", async () => {
  const { resolveVoicePillTravelPresentation } = await load();
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");

  assert.deepEqual(
    resolveVoicePillTravelPresentation({
      assistantMounted: true,
      liveTranscriptOpen: false,
      liveTranscriptEntrancePhase: "idle",
    }),
    { durationMs: MOTION_TIMING.morphMs, ease: "var(--motion-morph-ease)" }
  );
});

test("the Assistant panel's travel outranks a simultaneously-open Live Transcript phase", async () => {
  const { resolveVoicePillTravelPresentation } = await load();
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");

  // Both flags are only ever true together mid-handoff, but the precedence
  // still must pick the morph spring first, not fall through to Live
  // Transcript's encapsulate timing.
  assert.deepEqual(
    resolveVoicePillTravelPresentation({
      assistantMounted: true,
      liveTranscriptOpen: true,
      liveTranscriptEntrancePhase: "encapsulate",
    }),
    { durationMs: MOTION_TIMING.morphMs, ease: "var(--motion-morph-ease)" }
  );
});

test("Live Transcript's own pill travel keeps its established timings and the default CSS easing", async () => {
  const { resolveVoicePillTravelPresentation, LIVE_TRANSCRIPT_ENTRANCE_TIMING } = await load();

  assert.deepEqual(
    resolveVoicePillTravelPresentation({
      assistantMounted: false,
      liveTranscriptOpen: true,
      liveTranscriptEntrancePhase: "encapsulate",
    }),
    { durationMs: LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs, ease: undefined },
    "the encapsulate phase keeps its own shorter duration"
  );
  assert.deepEqual(
    resolveVoicePillTravelPresentation({
      assistantMounted: false,
      liveTranscriptOpen: true,
      liveTranscriptEntrancePhase: "controls",
    }),
    { durationMs: LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs, ease: undefined },
    "any other open phase falls back to the horizontal-travel duration"
  );
  assert.deepEqual(
    resolveVoicePillTravelPresentation({
      assistantMounted: false,
      liveTranscriptOpen: false,
      liveTranscriptEntrancePhase: "idle",
    }),
    { durationMs: LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs, ease: undefined },
    "the resting pill (neither panel mounted) also uses the horizontal-travel duration, unmodified"
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

  const { LISTENING_ENTRANCE_TIMING } = await load();
  assert.equal(LISTENING_ENTRANCE_TIMING.thinkingMs, 420);
  assert.equal(LISTENING_ENTRANCE_TIMING.expansionMs, 360);
  assert.equal(timeline.expandAtMs, 420);
  assert.equal(timeline.settleAtMs, 780);
  assert.equal(timeline.waveformAtMs, 880);
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

test("Agent identity ends at close intent so the colour fades inside the close spring", async () => {
  const { resolveAgentModeActive } = await load();
  const base = { isAssistantVoice: false, isRecording: false, isProcessing: false };
  assert.equal(resolveAgentModeActive({ ...base, assistantPanelMounted: true }), true);
  assert.equal(
    resolveAgentModeActive({ ...base, assistantPanelMounted: true, assistantPanelClosing: true }),
    false
  );
  // A live agent request keeps its identity even while a stale panel closes.
  assert.equal(
    resolveAgentModeActive({
      isAssistantVoice: true,
      isRecording: true,
      isProcessing: false,
      assistantPanelMounted: true,
      assistantPanelClosing: true,
    }),
    true
  );
});

// Decision 8: with auto-hide on, the leaf->ring morph (480ms) used to finish
// 20ms before the auto-hide cut (500ms), so a user who had just talked to the
// Agent watched the pill turn into the dictation logo and only then vanish.
// The mark is now held through the exit and the morph runs while the window
// is hidden. The App state that drives this has no test harness (src/App.jsx
// is not rendered by any test and checkJs is off), so every decision it makes
// lives here as a pure function instead.

test("a held agent mark survives the panel unmount until released, and a recording start wins", async () => {
  const { resolveAgentModeActive } = await load();
  const idle = { isAssistantVoice: false, isRecording: false, isProcessing: false };
  // Held -> true after the unmount.
  assert.equal(
    resolveAgentModeActive({ ...idle, assistantPanelMounted: false, heldThroughHide: true }),
    true
  );
  // Cleared -> false.
  assert.equal(
    resolveAgentModeActive({ ...idle, assistantPanelMounted: false, heldThroughHide: false }),
    false
  );
  // A new dictation recording is the dictation ring regardless of the hold
  // (App clears the hold on recording start; the resolver alone must not
  // brand it): with the hold cleared, a plain recording is not agent.
  assert.equal(
    resolveAgentModeActive({
      isAssistantVoice: false,
      isRecording: true,
      isProcessing: false,
      assistantPanelMounted: false,
      heldThroughHide: false,
    }),
    false
  );
});

test("only an auto-hide exit holds the agent mark past the panel close", async () => {
  const { shouldHoldAgentMarkThroughHide } = await load();
  assert.equal(
    shouldHoldAgentMarkThroughHide({ floatingIconAutoHide: true, assistantPanelMounted: true }),
    true,
    "the pill is about to leave — carry the leaf out with it"
  );
  assert.equal(
    shouldHoldAgentMarkThroughHide({ floatingIconAutoHide: false, assistantPanelMounted: true }),
    false,
    "the pill stays on screen, so the leaf->ring morph is a wanted, visible return"
  );
  assert.equal(
    shouldHoldAgentMarkThroughHide({ floatingIconAutoHide: true, assistantPanelMounted: false }),
    false,
    "no Agent panel was closed, so there is no agent identity to hold"
  );
});

test("a held agent mark is released by anything that keeps the pill on screen", async () => {
  const { shouldReleaseAgentMarkHold } = await load();
  const staged = { isRecording: false, isPreparing: false, floatingIconAutoHide: true };
  assert.equal(
    shouldReleaseAgentMarkHold(staged),
    false,
    "the staged exit is still pending — keep holding the leaf"
  );
  assert.equal(
    shouldReleaseAgentMarkHold({ ...staged, isRecording: true }),
    true,
    "a new recording start wins over the hold"
  );
  assert.equal(
    shouldReleaseAgentMarkHold({ ...staged, isPreparing: true }),
    true,
    "a recording that is still spinning up is already a new session"
  );
  assert.equal(
    shouldReleaseAgentMarkHold({ ...staged, floatingIconAutoHide: false }),
    true,
    "auto-hide switched off cancels the exit the hold was staged for"
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

// resolvePillShrinkWait: what a shrinking pill window should wait for.
//
// Fix round 1 (review of task-3-report.md, 2026-09-07), findings 1+2: Task 3
// wired App.jsx to wait on the pill's own width transitionend for EVERY
// shrink unconditionally. Two cases have no such event to wait for and used
// to burn the full settleFallbackMs fallback (480ms) doing nothing: (a) a
// shrink the pill's width is not part of at all — closing a menu or toast,
// retiring the hands-free tip — and (b) reduced motion, which strips `width`
// from the pill's transition-property outright (src/index.css's blanket
// rule), so even the pill's own RECORDING -> BASE narrow has nothing to fire
// there. Both are handled here so App.jsx's callback stays a thin wrapper.

function fakeElement() {
  const listenersByType = new Map();
  const setFor = (type) => {
    let set = listenersByType.get(type);
    if (!set) {
      set = new Set();
      listenersByType.set(type, set);
    }
    return set;
  };
  return {
    addEventListener: (type, fn) => setFor(type).add(fn),
    removeEventListener: (type, fn) => setFor(type).delete(fn),
    fire(target, propertyName, type = "transitionend") {
      for (const fn of [...setFor(type)]) fn({ target, propertyName, type });
    },
    get listenerCount() {
      let total = 0;
      for (const set of listenersByType.values()) total += set.size;
      return total;
    },
  };
}

test("resolvePillShrinkWait resolves at once for any shrink that is not the pill's own narrow", async () => {
  const { resolvePillShrinkWait } = await load();
  const el = fakeElement();

  for (const [prev, target] of [
    ["BASE", "WITH_MENU"], // a grow: this helper is only ever called on a shrink, but must still no-op
    ["WITH_MENU", "BASE"],
    ["WITH_MENU", "RECORDING"],
    ["HANDS_FREE_TIP", "BASE"],
    ["WITH_TOAST", "WITH_MENU"],
    ["EXPANDED", "WITH_MENU"],
  ]) {
    const result = await resolvePillShrinkWait({ target, prev, prefersReducedMotion: false, el });
    assert.equal(result, undefined, `"${prev}" -> "${target}" must resolve at once`);
    assert.equal(el.listenerCount, 0, `must never listen for a "${prev}" -> "${target}" shrink`);
  }
});

test("resolvePillShrinkWait resolves at once under reduced motion, even for the pill's own narrow", async () => {
  const { resolvePillShrinkWait } = await load();
  const el = fakeElement();
  const result = await resolvePillShrinkWait({
    target: "BASE",
    prev: "RECORDING",
    prefersReducedMotion: true,
    el,
  });
  assert.equal(result, "reduced-motion");
  assert.equal(
    el.listenerCount,
    0,
    "must never listen for a width transitionend that reduced motion cannot fire"
  );
});

test("resolvePillShrinkWait waits for the real width transition on the pill's own narrow, falling back at exactly settleFallbackMs's boundary", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { resolvePillShrinkWait } = await load();
  const { settleFallbackMs } = await import("../../src/utils/transitionSettled.ts");
  const { LISTENING_ENTRANCE_TIMING } = await load();
  const expectedFallbackMs = settleFallbackMs(LISTENING_ENTRANCE_TIMING.expansionMs);
  assert.equal(expectedFallbackMs, 480, "sanity pin: 360ms pinned duration + 120ms grace");

  const el = fakeElement(); // deliberately never fired
  const settled = resolvePillShrinkWait({
    target: "BASE",
    prev: "RECORDING",
    prefersReducedMotion: false,
    el,
  });
  assert.equal(el.listenerCount, 2, "must register for both transitionend and transitioncancel");

  let settledYet = false;
  settled.then(() => (settledYet = true));
  t.mock.timers.tick(expectedFallbackMs - 1);
  await Promise.resolve();
  assert.equal(settledYet, false, "must not resolve before settleFallbackMs's boundary");

  t.mock.timers.tick(1);
  assert.equal(await settled, "timeout");
});

test("resolvePillShrinkWait's own narrow resolves early when the real transitionend fires, not at the fallback", async () => {
  const { resolvePillShrinkWait } = await load();
  const el = fakeElement();
  const settled = resolvePillShrinkWait({
    target: "BASE",
    prev: "RECORDING",
    prefersReducedMotion: false,
    el,
  });
  el.fire(el, "width");
  assert.equal(await settled, "transitionend");
});

// resolveHandsFreeTipLadderVisible: does the window-size ladder still need
// to reserve HANDS_FREE_TIP room?
//
// Fix round 2 (review of task-3-report.md's fix round 1, 2026-09-07): round
// 1 made resolvePillShrinkWait resolve a HANDS_FREE_TIP -> BASE shrink at
// once, correctly, since the pill's own width is not part of that
// transition — but that only stays safe if the LADDER INPUT
// (App.jsx's tipCardVisible) itself is not lying about whether something is
// still on screen. Before this fix it read holdMigrationCard.visible alone,
// which the hook returns as `visible && !exiting` — so it drops to false the
// INSTANT dismissal starts, while the card stays mounted for its own 200ms
// exit fade (`.hands-free-tip-card[data-exiting="true"]`,
// dictation-panel.css). The old 340ms/480ms guesses happened to outlast that
// fade by accident; round 1 removed that accident. This widens the decision
// to the card's whole MOUNTED lifetime (visible OR exiting), so the ladder
// only lets go once the card has actually unmounted and there is nothing
// left to clip.

test("resolveHandsFreeTipLadderVisible stays true for the migration card's whole mounted lifetime, including its exit fade", async () => {
  const { resolveHandsFreeTipLadderVisible } = await load();
  assert.equal(
    resolveHandsFreeTipLadderVisible({
      tip: null,
      holdMigrationCardVisible: true,
      holdMigrationCardExiting: false,
    }),
    true,
    "the card is fully shown"
  );
  assert.equal(
    resolveHandsFreeTipLadderVisible({
      tip: null,
      holdMigrationCardVisible: false,
      holdMigrationCardExiting: true,
    }),
    true,
    "the card is exiting — still mounted and fading, must still reserve room"
  );
  assert.equal(
    resolveHandsFreeTipLadderVisible({
      tip: null,
      holdMigrationCardVisible: false,
      holdMigrationCardExiting: false,
    }),
    false,
    "the card has actually unmounted — nothing left to reserve room for"
  );
});

test("resolveHandsFreeTipLadderVisible leaves the hands-free tip card's own visibility untouched by the widening", async () => {
  const { resolveHandsFreeTipLadderVisible } = await load();
  assert.equal(
    resolveHandsFreeTipLadderVisible({
      tip: { inputKind: "dictation" },
      holdMigrationCardVisible: false,
      holdMigrationCardExiting: false,
    }),
    true,
    "the hands-free tip card has no exiting sub-state of its own; its own tip !== null is untouched"
  );
  assert.equal(
    resolveHandsFreeTipLadderVisible({
      tip: null,
      holdMigrationCardVisible: false,
      holdMigrationCardExiting: false,
    }),
    false
  );
});

// Task 9: the pill's exit "zoop" is a transform transition, and the native
// window waits for it. Two states have no transform transition to wait for at
// all, so waiting would park the hide for the whole fallback window instead of
// choreographing anything.
test("the exit waits for its zoop only when there is really a zoop to wait for", async () => {
  const { shouldAwaitPillZoop } = await load();

  assert.equal(shouldAwaitPillZoop({ prefersReducedMotion: false, alreadyExited: false }), true);
  // index.css's blanket reduced-motion rule strips transform from
  // transition-property with !important, so the transitionend this waits on
  // can never fire — the hide would only ever land on its fallback.
  assert.equal(shouldAwaitPillZoop({ prefersReducedMotion: true, alreadyExited: false }), false);
  // Re-entering a pose the element already holds starts no transition either.
  assert.equal(shouldAwaitPillZoop({ prefersReducedMotion: false, alreadyExited: true }), false);
  assert.equal(shouldAwaitPillZoop({ prefersReducedMotion: true, alreadyExited: true }), false);
});

// Task 10: the Live Transcript entrance's first two beats stop being bare
// timers and start on the shell's own clip-path `transitionend`, with the old
// timers kept only as fallbacks. resolveLiveTranscriptStageGate is the whole
// decision: whether there is an event to wait for at all, and how long the
// beat waits on its own if none arrives.
test("each entrance gate waits for the shell's own stage transition, with the old timer plus a grace window behind it", async () => {
  const { resolveLiveTranscriptStageGate, LIVE_TRANSCRIPT_ENTRANCE_TIMING, LIVE_TRANSCRIPT_STAGE_GATE_GRACE_MS } =
    await load();

  assert.deepEqual(
    resolveLiveTranscriptStageGate({ stage: "encapsulated", prefersReducedMotion: false }),
    {
      awaitEvent: true,
      waitMs: LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs + LIVE_TRANSCRIPT_STAGE_GATE_GRACE_MS,
    }
  );
  assert.deepEqual(resolveLiveTranscriptStageGate({ stage: "footer", prefersReducedMotion: false }), {
    awaitEvent: true,
    waitMs: LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs + LIVE_TRANSCRIPT_STAGE_GATE_GRACE_MS,
  });
  assert.ok(
    LIVE_TRANSCRIPT_STAGE_GATE_GRACE_MS > 0,
    "the fallback must sit BEHIND the transition it backs up, never race it"
  );
});

// The reduced-motion half, and the reason this needs its own decision rather
// than a timeout: src/index.css's blanket `*, *::before, *::after` rule sets
// transition-property with !important to a list that EXCLUDES clip-path, so
// the shell's stage clip simply applies and there is no transition to end —
// the same shape resolvePillShrinkWait uses for `width` and
// shouldAwaitPillZoop for `transform`. Waiting anyway would hold every beat
// for its whole fallback window and make the entrance SLOWER under reduced
// motion than with motion on.
test("reduced motion never waits for a clip-path transitionend that can structurally never fire", async () => {
  const { resolveLiveTranscriptStageGate, LIVE_TRANSCRIPT_ENTRANCE_TIMING } = await load();

  assert.deepEqual(
    resolveLiveTranscriptStageGate({ stage: "encapsulated", prefersReducedMotion: true }),
    { awaitEvent: false, waitMs: LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs }
  );
  assert.deepEqual(resolveLiveTranscriptStageGate({ stage: "footer", prefersReducedMotion: true }), {
    awaitEvent: false,
    waitMs: LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs,
  });
});

// The stages and their durations must not change — only what triggers each
// step. Under reduced motion (no event, plain timers) the chain must land on
// exactly the instants getLiveTranscriptEntranceTimeline already publishes,
// which is what "unchanged" means arithmetically.
test("the reduced-motion gate chain lands on the entrance timeline's own published instants", async () => {
  const {
    resolveLiveTranscriptStageGate,
    getLiveTranscriptEntranceTimeline,
    LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  } = await load();
  const timeline = getLiveTranscriptEntranceTimeline();

  const encapsulated = resolveLiveTranscriptStageGate({
    stage: "encapsulated",
    prefersReducedMotion: true,
  });
  const footer = resolveLiveTranscriptStageGate({ stage: "footer", prefersReducedMotion: true });

  assert.equal(
    encapsulated.waitMs + LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateHoldMs,
    timeline.horizontalAtMs,
    "the horizontal phase must still start at its published instant"
  );
  assert.equal(
    encapsulated.waitMs +
      LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateHoldMs +
      footer.waitMs +
      LIVE_TRANSCRIPT_ENTRANCE_TIMING.controlsDelayMs,
    timeline.controlsAtMs,
    "the controls phase must still start at its published instant"
  );
});
