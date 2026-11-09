const test = require("node:test");
const assert = require("node:assert/strict");
const { React, renderStatic } = require("./harness/reactSsr");

const renderCore = async (mode, open, stage = "content", horizontalDirection = "right") => {
  const { VoiceModePanelCore } =
    await import("../../src/components/dictation/VoiceModePanelCore.tsx");
  return renderStatic(
    VoiceModePanelCore,
    {
      mode,
      open,
      stage,
      horizontalDirection,
      onPreferredHeightChange: () => {},
    },
    React.createElement("main", { "data-mode-content": mode ?? "idle" })
  );
};

test("Live Transcript renders one expanding panel surface through every stage", async () => {
  const liveTranscriptCapsule = await renderCore("live-transcript", true, "encapsulated");
  const liveTranscriptFooter = await renderCore("live-transcript", true, "footer");
  const liveTranscriptContent = await renderCore("live-transcript", true, "content");

  for (const markup of [liveTranscriptCapsule, liveTranscriptFooter, liveTranscriptContent]) {
    assert.match(markup, /^<section class="expanding-panel-surface/);
    assert.match(markup, /expanding-panel-anchor-bottom-right/);
    assert.match(markup, /h-fit/);
    assert.equal((markup.match(/<section/g) || []).length, 1);
  }
  assert.match(liveTranscriptCapsule, /data-panel-stage="encapsulated"/);
  assert.match(liveTranscriptFooter, /data-panel-mode="live-transcript"/);
  assert.match(liveTranscriptFooter, /data-panel-stage="footer"/);
  assert.match(liveTranscriptContent, /data-panel-height-stabilized="true"/);
});

test("Live Transcript keeps a left origin through every panel stage", async () => {
  const liveTranscriptCapsule = await renderCore("live-transcript", true, "encapsulated", "left");
  const liveTranscriptFooter = await renderCore("live-transcript", true, "footer", "left");
  const liveTranscriptContent = await renderCore("live-transcript", true, "content", "left");

  for (const markup of [liveTranscriptCapsule, liveTranscriptFooter, liveTranscriptContent]) {
    assert.match(markup, /expanding-panel-anchor-bottom-left/);
    assert.match(markup, /data-panel-direction="left"/);
    assert.doesNotMatch(markup, /expanding-panel-anchor-bottom-right/);
  }
});

test("the shared core keeps its surface mounted while no mode is active", async () => {
  const idle = await renderCore(null, false);

  assert.match(idle, /^<section class="expanding-panel-surface/);
  assert.match(idle, /aria-hidden="true"/);
  assert.equal((idle.match(/<section/g) || []).length, 1);
});
