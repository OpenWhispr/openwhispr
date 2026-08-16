const test = require("node:test");
const assert = require("node:assert/strict");
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

  assert.match(idle, /shrink-0 transition-\[color,width,height\] duration-200 text-foreground/);
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
    await import("../../src/components/dictation/LiveWaveform.tsx");

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
