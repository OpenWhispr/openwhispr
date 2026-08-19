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
  assert.match(thinking, /plain-dictation-processing-glow/);
  assert.match(recording, /^<div data-beam="[^"]+" class="agent-thinking-beam/);
  assert.doesNotMatch(recording, /plain-dictation-processing-glow/);
  assert.equal((thinking.match(/rounded-full bg-current/g) || []).length, 22);
  assert.equal((recording.match(/rounded-full bg-current/g) || []).length, 22);
});

test("plain dictation processing strengthens only the light-theme radial bloom", async () => {
  const sourceRoot = path.resolve(__dirname, "../..");
  const styles = fs.readFileSync(path.join(sourceRoot, "src/index.css"), "utf8");
  const agentThinking = await renderPill("thinking", false, "right", { agentMode: true });

  assert.match(
    styles,
    /:root:not\(\.dark\) \.agent-thinking-beam\.plain-dictation-processing-glow\s*\{[^}]*--beam-stroke-opacity: 6\.25;[^}]*--beam-bloom-opacity: 2\.2;/s
  );
  assert.doesNotMatch(agentThinking, /plain-dictation-processing-glow/);
});

test("panel thinking contracts to the identity circle instead of freezing a waveform", async () => {
  const panelThinking = await renderPill("thinking", false, "right", {
    variant: "panel",
    agentMode: true,
  });

  assert.match(panelThinking, /style="width:40px;height:40px/);
  assert.match(panelThinking, /data-agent-beam-active="true"/);
  assert.doesNotMatch(panelThinking, /style="width:92px;height:36px/);
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
  const hovered = await renderPill("hover", false);

  assert.match(hovered, /border-border-hover bg-surface-3 text-foreground/);
  assert.match(hovered, /box-shadow:var\(--shadow-card-hover-subtle\)/);
  assert.doesNotMatch(hovered, /style="[^"]*transform:/);
  assert.match(hovered, /style="width:40px;height:40px/);
  assert.match(hovered, /<svg width="22" height="22"/);
});

test("dictation errors preserve the pill root until compact bounds settle", () => {
  const sourceRoot = path.resolve(__dirname, "../..");
  const appSource = fs.readFileSync(path.join(sourceRoot, "src/App.jsx"), "utf8");
  const pillMarkup = appSource.slice(
    appSource.indexOf("{/* The panel footer owns this pill"),
    appSource.indexOf("<VoiceModePanelCore")
  );
  const errorExit = appSource.slice(
    appSource.indexOf('if (prev === "DICTATION_ERROR"'),
    appSource.indexOf("if (returningFromPanel")
  );

  assert.doesNotMatch(pillMarkup, /dictationErrorActionCount === 0\s*&&/);
  assert.match(pillMarkup, /data-dictation-error-suppressed/);
  assert.match(errorExit, /dictationErrorPillHandoffRef\.current\.releaseAfter/);
  assert.ok(errorExit.indexOf("await requestMainWindowSize") >= 0);
});

test("dictation error visibility cannot deadlock on native content sizing", () => {
  const sourceRoot = path.resolve(__dirname, "../..");
  const toastSource = fs.readFileSync(path.join(sourceRoot, "src/components/ui/Toast.tsx"), "utf8");

  assert.match(toastSource, /presentation !== "dictation-error" \|\| errorSurfaceReady/);
  assert.match(toastSource, /setTimeout\(\(\) => \{[\s\S]*setErrorSurfaceReady\(true\)[\s\S]*240/);
  assert.match(
    toastSource,
    /resizeDictationErrorWindowToContent[\s\S]*finally[\s\S]*setErrorSurfaceReady\(true\)/
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
  const { WAVEFORM_BAR_MIN_PX, WAVEFORM_BAR_MAX_PX, resolveWaveformBarHeight } =
    await import("../../src/components/dictation/waveformMath.ts");

  assert.match(recording, /relative shrink-0 overflow-hidden text-foreground/);
  assert.equal((recording.match(/w-0\.5 rounded-full bg-current/g) || []).length, 22);
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

test("Agent Mode uses the supplied mark, a purple perimeter beam, and a neutral waveform", async () => {
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
  assert.match(styles, /--beam-hue-base: 18deg/);
  assert.match(styles, /--beam-inner-opacity: 0/);
  assert.match(styles, /--beam-bloom-opacity: 0/);
  assert.doesNotMatch(styles, /agent-waveform-background|agent-waveform-highlight/);
  assert.match(agentRecording, /^<div [^>]*class="agent-thinking-beam/);
  assert.match(agentRecording, /^<div [^>]*data-beam="[^"]+"/);
  assert.match(agentRecording, /^<div [^>]*data-active=""/);
  assert.match(agentRecording, /data-agent-mode="true"/);
  assert.match(agentRecording, /voice-identity-final-agent agent-mode-mark/);
  assert.doesNotMatch(agentRecording, /agent-waveform-background|text-agent-brand/);
  assert.equal((agentRecording.match(/w-0\.5 rounded-full bg-current/g) || []).length, 22);
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
