const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { renderStatic } = require("./harness/reactSsr");

const sourceRoot = path.resolve(__dirname, "../..");
// The dictation-window feature styles are split out of index.css; selectors
// under test may live in either file.
const readDictationStyles = () =>
  fs.readFileSync(path.join(sourceRoot, "src/index.css"), "utf8") +
  fs.readFileSync(path.join(sourceRoot, "src/styles/dictation-panel.css"), "utf8");

// The pill renders the resting silhouette and the live waveform as two
// stacked bar sets, both sized from the shared bar count.
const totalWaveBars = async () => {
  const { WAVEFORM_BAR_COUNT } = await import("../../src/components/dictation/waveformMath.ts");
  return WAVEFORM_BAR_COUNT * 2;
};

// The pill's rendered footprints are a native-window contract (see
// VOICE_PILL_FOOTPRINT); every footprint assertion derives from the exported
// constants so the literals live in exactly one place.
const pillFootprints = async () => {
  const { VOICE_PILL_FOOTPRINT } = await import("../../src/helpers/voicePillPresentation.js");
  const asStyle = ({ width, height }) => new RegExp(`style="width:${width}px;height:${height}px`);
  return {
    idle: asStyle(VOICE_PILL_FOOTPRINT.idle),
    recording: asStyle(VOICE_PILL_FOOTPRINT.recording),
  };
};

const renderPill = async (state, expanded, horizontalDirection = "right", overrides = {}) => {
  const { VoicePill } = await import("../../src/components/dictation/VoicePill.tsx");
  return renderStatic(VoicePill, {
    variant: "floating",
    state,
    expanded,
    horizontalDirection,
    getAudioLevel: () => 0,
    ...overrides,
  });
};

test("thinking and recording keep the same persistent glow and pill roots", async () => {
  const thinking = await renderPill("thinking", false);
  const recording = await renderPill("recording", true);

  for (const markup of [thinking, recording]) {
    assert.match(markup, /^<span class="voice-pill-glow-anchor"/);
    assert.match(markup, /class="processing-signal-glow"/);
    assert.match(markup, /voice-pill-control/);
  }
  assert.match(thinking, /class="processing-signal-glow" data-active="true"/);
  assert.doesNotMatch(recording, /data-active/);
  const expectedBars = await totalWaveBars();
  assert.equal((thinking.match(/rounded-full bg-current/g) || []).length, expectedBars);
  assert.equal((recording.match(/rounded-full bg-current/g) || []).length, expectedBars);
});

test("one Signal glow serves both identities: blue processing, purple agent", async () => {
  const styles = readDictationStyles();
  const agentThinking = await renderPill("thinking", false, "right", { agentMode: true });
  // Listening must not glow in either identity: a glow before any transcript
  // exists reads as work already in flight.
  const agentListening = await renderPill("recording", false, "right", { agentMode: true });

  assert.match(styles, /\.processing-signal-glow\s*\{/);
  assert.match(styles, /:root:not\(\.dark\) \.processing-signal-glow\s*\{/);
  assert.match(
    agentThinking,
    /class="processing-signal-glow" data-active="true" data-agent="true"/
  );
  assert.doesNotMatch(agentListening, /data-active/);
});

test("the pill renders exactly the footprints the native window ladder is sized around", async () => {
  const footprint = await pillFootprints();
  const idle = await renderPill("idle", false);
  const recording = await renderPill("recording", true);

  assert.match(idle, footprint.idle);
  assert.doesNotMatch(idle, footprint.recording);
  assert.match(recording, footprint.recording);
  assert.doesNotMatch(recording, footprint.idle);
});

test("panel thinking contracts to the identity circle instead of freezing a waveform", async () => {
  const footprint = await pillFootprints();
  const panelThinking = await renderPill("thinking", false, "right", {
    variant: "panel",
    agentMode: true,
  });

  assert.match(panelThinking, footprint.idle);
  assert.match(panelThinking, /data-agent-beam-active="true"/);
  assert.doesNotMatch(panelThinking, footprint.recording);
});

test("an idle Agent panel starts with the normal pill and expands only while listening", async () => {
  const footprint = await pillFootprints();
  const idleAgent = await renderPill("idle", false, "right", {
    variant: "panel",
    agentMode: true,
    waveformOnlyWhileRecording: true,
  });
  const listeningAgent = await renderPill("recording", false, "right", {
    variant: "panel",
    agentMode: true,
    waveformOnlyWhileRecording: true,
  });

  assert.match(idleAgent, footprint.idle);
  assert.doesNotMatch(idleAgent, footprint.recording);
  assert.doesNotMatch(idleAgent, /data-active/);
  assert.match(listeningAgent, footprint.recording);
  assert.doesNotMatch(listeningAgent, /data-active/);
});

test("the waveform stays to the right of the identity across docks and voice modes", async () => {
  const right = await renderPill("recording", true, "right");
  const left = await renderPill("recording", true, "left");
  const leftAgent = await renderPill("recording", true, "left", {
    agentMode: true,
  });
  const leftLiveTranscript = await renderPill("recording", true, "left", {
    variant: "panel",
    integratedWithPanel: true,
  });

  assert.match(right, /data-horizontal-direction="right"/);
  assert.match(right, /voice-pill-control[^"\n]*pr-1/);
  assert.match(left, /data-horizontal-direction="left"/);
  assert.match(left, /voice-pill-control[^"\n]*pr-1/);

  for (const markup of [right, left, leftAgent, leftLiveTranscript]) {
    assert.doesNotMatch(markup, /flex-row-reverse/);
    assert.ok(markup.indexOf("voice-pill-identity-slot") >= 0);
    assert.ok(markup.indexOf("voice-pill-waveform") > markup.indexOf("voice-pill-identity-slot"));
  }
});

test("the collapsed Live Transcript pill transitions its logo into an expand chevron", async () => {
  const resting = await renderPill("recording", true);
  const hovered = await renderPill("recording", true, "right", {
    showExpandChevron: true,
  });
  const leftHovered = await renderPill("recording", true, "left", {
    showExpandChevron: true,
  });

  assert.doesNotMatch(resting, /data-expand-chevron/);
  assert.match(resting, /voice-pill-identity-logo[^"\n]*scale-100 opacity-100/);
  assert.match(resting, /voice-pill-expand-chevron[^"\n]*opacity-0/);
  assert.match(hovered, /data-expand-chevron="true"/);
  assert.match(hovered, /voice-pill-identity-logo[^"\n]*opacity-0/);
  assert.match(hovered, /voice-pill-expand-chevron[^"\n]*scale-100 opacity-100/);
  assert.doesNotMatch(leftHovered, /flex-row-reverse/);
  assert.ok(
    leftHovered.indexOf("voice-pill-expand-chevron") < leftHovered.indexOf("voice-pill-waveform")
  );
});

test("the idle pill keeps the logo at normal foreground strength", async () => {
  const idle = await renderPill("idle", false);

  assert.match(idle, /border-border-hover[^"\n]*dark:border-border\/50/);
  assert.match(
    idle,
    /voice-identity-icon relative inline-block shrink-0 transition-\[width,height\] duration-200 text-foreground/
  );
});

test("the floating hover pill changes surface treatment without zooming", async () => {
  const footprint = await pillFootprints();
  const hovered = await renderPill("hover", false);

  assert.match(hovered, /border-border-hover bg-surface-3 text-foreground/);
  assert.match(hovered, /box-shadow:var\(--shadow-card-hover-subtle\)/);
  assert.doesNotMatch(hovered, /style="[^"]*transform:/);
  assert.match(hovered, footprint.idle);
  assert.match(hovered, /<svg width="22" height="22"/);
});

test("the waveform pill keeps the normal compact logo footprint", async () => {
  const idle = await renderPill("idle", false);
  const recording = await renderPill("recording", true);
  const liveTranscript = await renderPill("recording", true, "right", {
    variant: "panel",
    integratedWithPanel: true,
  });

  for (const markup of [idle, recording, liveTranscript]) {
    assert.match(markup, /<svg width="22" height="22"/);
  }
});

test("an interactive voice pill is keyboard focusable", async () => {
  const interactive = await renderPill("recording", true, "right", {
    role: "button",
    tabIndex: 0,
  });

  assert.match(interactive, /role="button"/);
  assert.match(interactive, /tabindex="0"/);
});

test("the waveform uses foreground contrast, rounded caps, and a pronounced height range", async () => {
  const recording = await renderPill("recording", true);
  const { WAVEFORM_BAR_MIN_PX, WAVEFORM_BAR_MAX_PX, resolveWaveformBarHeight } =
    await import("../../src/components/dictation/waveformMath.ts");

  assert.match(recording, /relative shrink-0 overflow-hidden text-foreground/);
  assert.equal(
    (recording.match(/w-0\.5 rounded-full bg-current/g) || []).length,
    await totalWaveBars()
  );
  assert.equal(WAVEFORM_BAR_MIN_PX, 4);
  assert.equal(WAVEFORM_BAR_MAX_PX, 22);
  assert.equal(resolveWaveformBarHeight(0), WAVEFORM_BAR_MIN_PX);
  assert.equal(resolveWaveformBarHeight(1), WAVEFORM_BAR_MAX_PX);
  assert.ok(resolveWaveformBarHeight(0.15) > 20);
});

test("Live Transcript hands visual border ownership to the shared panel", async () => {
  const integrated = await renderPill("recording", true, "right", {
    variant: "panel",
    integratedWithPanel: true,
  });
  const standalone = await renderPill("recording", true);

  assert.match(integrated, /voice-pill-control/);
  assert.match(integrated, /data-integrated-with-panel="true"/);
  assert.doesNotMatch(standalone, /data-integrated-with-panel/);
});

test("Agent Mode uses the supplied mark, a purple perimeter glow, and a neutral waveform", async () => {
  const agentRecording = await renderPill("recording", true, "right", {
    agentMode: true,
  });
  const normalRecording = await renderPill("recording", true);
  const { AGENT_MODE_PATH } = await import("../../src/components/dictation/voiceIdentityMorph.ts");
  const styles = readDictationStyles();

  assert.match(AGENT_MODE_PATH, /^M6\.14226 /);
  assert.match(styles, /--color-agent-brand:/);
  assert.doesNotMatch(styles, /\.voice-pill-control\[data-agent-mode="true"\]\s*\{/);
  // The agent glow is the same Signal treatment re-palettes to the agent's
  // purple around the brand color.
  assert.match(styles, /\.processing-signal-glow\[data-agent="true"\]\s*\{/);
  assert.match(styles, /--signal-core: #8787ff/);
  assert.doesNotMatch(styles, /agent-waveform-background|agent-waveform-highlight/);
  // Listening stays glow-free; the purple Signal glow is reserved for the
  // post-recording thinking state so "hearing you" and "working" read apart.
  assert.match(agentRecording, /class="processing-signal-glow" data-agent="true"/);
  assert.doesNotMatch(agentRecording, /data-active/);
  assert.match(agentRecording, /data-agent-mode="true"/);
  assert.match(agentRecording, /voice-identity-final-agent/);
  assert.ok(agentRecording.includes(`d="${AGENT_MODE_PATH}"`));
  assert.doesNotMatch(agentRecording, /agent-waveform-background|text-agent-brand/);
  assert.equal(
    (agentRecording.match(/w-0\.5 rounded-full bg-current/g) || []).length,
    await totalWaveBars()
  );
  assert.doesNotMatch(normalRecording, /agent-waveform-background/);
});

test("Agent thinking keeps the purple glow on the same persistent pill root", async () => {
  const agentThinking = await renderPill("thinking", false, "right", {
    agentMode: true,
  });

  assert.match(
    agentThinking,
    /class="processing-signal-glow" data-active="true" data-agent="true"/
  );
  assert.match(agentThinking, /<div [^>]*data-agent-mode="true"/);
  assert.match(agentThinking, /data-agent-beam-active="true"/);
});

test("the stable identity box stages the sound-bars into the Agent mark", async () => {
  const idle = await renderPill("idle", false);
  const agentThinking = await renderPill("thinking", false, "right", {
    agentMode: true,
  });

  assert.match(idle, /data-agent-mode="false"/);
  assert.match(idle, /voice-identity-morph-shell/);
  assert.match(idle, /voice-identity-morph-bar-left/);
  assert.match(idle, /voice-identity-morph-bar-center/);
  assert.match(idle, /voice-identity-morph-bar-right/);
  assert.match(agentThinking, /data-agent-mode="true"/);
  assert.match(agentThinking, /voice-identity-final-agent/);
});

test("the voice identity performs an actual SVG geometry morph", async () => {
  const { resolveVoiceIdentityMorphPaths } =
    await import("../../src/components/dictation/voiceIdentityMorph.ts");
  const listening = resolveVoiceIdentityMorphPaths(0);
  const midpoint = resolveVoiceIdentityMorphPaths(0.5);
  const agent = resolveVoiceIdentityMorphPaths(1);

  assert.notEqual(listening.shell, midpoint.shell);
  assert.notEqual(midpoint.shell, agent.shell);
  assert.notEqual(listening.centerBar, midpoint.centerBar);
  assert.notEqual(midpoint.centerBar, agent.centerBar);
  assert.equal(listening.agentOpacity, 0);
  assert.ok(midpoint.sparkOpacity > 0);
  assert.equal(agent.agentOpacity, 1);
  assert.equal(agent.constructionOpacity, 0);
});
