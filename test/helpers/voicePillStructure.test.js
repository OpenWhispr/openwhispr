const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

globalThis.React = React;

const renderPill = async (state, expanded, horizontalDirection = "right", overrides = {}) => {
  const { VoicePill } = await import("../../src/components/dictation/VoicePill.tsx");
  const markup = renderToStaticMarkup(
    React.createElement(VoicePill, {
      variant: "floating",
      state,
      expanded,
      horizontalDirection,
      getAudioLevel: () => 0,
      ...overrides,
    })
  );
  return markup.slice(markup.indexOf("</style>") + "</style>".length);
};

test("thinking and recording keep the same persistent Beam and pill roots", async () => {
  const thinking = await renderPill("thinking", false);
  const recording = await renderPill("recording", true);

  assert.match(thinking, /^<div data-beam="[^"]+" data-active="" class="agent-thinking-beam/);
  assert.match(recording, /^<div data-beam="[^"]+" class="agent-thinking-beam/);
  assert.equal((thinking.match(/rounded-full bg-current/g) || []).length, 22);
  assert.equal((recording.match(/rounded-full bg-current/g) || []).length, 22);
});

test("the persistent pill mirrors its content order for a left-origin interaction", async () => {
  const right = await renderPill("recording", true, "right");
  const left = await renderPill("recording", true, "left");

  assert.match(right, /data-horizontal-direction="right"/);
  assert.doesNotMatch(right, /flex-row-reverse/);
  assert.match(left, /flex-row-reverse/);
  assert.match(left, /data-horizontal-direction="left"/);
});

test("the idle pill keeps the logo at normal foreground strength", async () => {
  const idle = await renderPill("idle", false);

  assert.match(
    idle,
    /voice-identity-icon relative inline-block shrink-0 transition-\[color,width,height\] duration-200 text-foreground/
  );
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

test("the waveform uses foreground contrast, rounded caps, and a pronounced height range", async () => {
  const recording = await renderPill("recording", true);
  const {
    WAVEFORM_BAR_MIN_PX,
    WAVEFORM_BAR_MAX_PX,
    resolveAgentWaveformBarHeight,
    resolveWaveformBarHeight,
  } = await import("../../src/components/dictation/waveformMath.ts");

  assert.match(recording, /relative shrink-0 overflow-hidden text-foreground/);
  assert.equal((recording.match(/w-0\.5 rounded-full bg-current/g) || []).length, 22);
  assert.equal(WAVEFORM_BAR_MIN_PX, 4);
  assert.equal(WAVEFORM_BAR_MAX_PX, 22);
  assert.equal(resolveWaveformBarHeight(0), WAVEFORM_BAR_MIN_PX);
  assert.equal(resolveWaveformBarHeight(1), WAVEFORM_BAR_MAX_PX);
  assert.ok(resolveWaveformBarHeight(0.15) > 20);
  assert.equal(resolveAgentWaveformBarHeight(new Array(11).fill(0), 5), WAVEFORM_BAR_MIN_PX);
  assert.notEqual(
    resolveAgentWaveformBarHeight([0, 0.04, 0.15, 0.02, 0.08, 0.2, 0.01, 0, 0.06, 0.03, 0], 5),
    resolveWaveformBarHeight(0.2)
  );
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

test("Agent Mode uses the supplied mark, neutral border, ocean beam, and layered waveform", async () => {
  const agentRecording = await renderPill("recording", true, "right", {
    agentMode: true,
  });
  const normalRecording = await renderPill("recording", true);
  const sourceRoot = path.resolve(__dirname, "../..");
  const asset = fs.readFileSync(path.join(sourceRoot, "src/assets/icons/agent-mode.svg"), "utf8");
  const styles = fs.readFileSync(path.join(sourceRoot, "src/index.css"), "utf8");

  assert.match(asset, /fill="#8787FF"/);
  assert.match(styles, /--color-agent-brand: #8787ff/);
  assert.doesNotMatch(styles, /\.voice-pill-control\[data-agent-mode="true"\]\s*\{/);
  assert.match(styles, /animation: agent-waveform-highlight 2\.4s linear infinite/);
  assert.match(agentRecording, /^<div [^>]*class="agent-thinking-beam/);
  assert.match(agentRecording, /^<div [^>]*data-beam="[^"]+"/);
  assert.match(agentRecording, /data-agent-mode="true"/);
  assert.match(agentRecording, /voice-identity-final-agent agent-mode-mark/);
  assert.match(
    agentRecording,
    /agent-waveform-background[^>]*text-agent-brand" data-active="true"/
  );
  assert.match(
    agentRecording,
    /agent-waveform-foreground[^>]*data-agent-mode="true" data-active="true"/
  );
  assert.equal((agentRecording.match(/w-0\.5 rounded-full bg-current/g) || []).length, 33);
  assert.doesNotMatch(normalRecording, /agent-waveform-background/);
});

test("Agent thinking keeps the purple beam on the same persistent pill root", async () => {
  const agentThinking = await renderPill("thinking", false, "right", {
    agentMode: true,
  });

  assert.match(agentThinking, /^<div [^>]*class="agent-thinking-beam/);
  assert.match(agentThinking, /^<div [^>]*data-beam="[^"]+"/);
  assert.match(agentThinking, /^<div [^>]*data-active=""/);
  assert.match(agentThinking, /^<div [^>]*data-agent-mode="true"/);
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
  assert.match(agentThinking, /agent-mode-mark/);
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
