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

const renderClosingAssistant = async () => {
  const { VoiceModePanelCore } =
    await import("../../src/components/dictation/VoiceModePanelCore.tsx");
  return renderStatic(
    VoiceModePanelCore,
    {
      mode: "assistant",
      open: true,
      closing: true,
      horizontalDirection: "right",
      onPreferredHeightChange: () => {},
    },
    React.createElement("main", null, "Agent content")
  );
};

test("Agent and live transcript use the same expanded panel core", async () => {
  const assistant = await renderCore("assistant", true);
  const liveTranscriptCapsule = await renderCore("live-transcript", true, "encapsulated");
  const liveTranscriptFooter = await renderCore("live-transcript", true, "footer");
  const liveTranscriptContent = await renderCore("live-transcript", true, "content");

  assert.match(assistant, /^<section class="expanding-panel-surface/);
  assert.match(liveTranscriptCapsule, /^<section class="expanding-panel-surface/);
  assert.match(liveTranscriptFooter, /^<section class="expanding-panel-surface/);
  assert.match(liveTranscriptContent, /^<section class="expanding-panel-surface/);
  assert.match(assistant, /expanding-panel-anchor-bottom-right/);
  assert.match(liveTranscriptCapsule, /expanding-panel-anchor-bottom-right/);
  assert.match(liveTranscriptFooter, /expanding-panel-anchor-bottom-right/);
  assert.match(liveTranscriptContent, /expanding-panel-anchor-bottom-right/);
  assert.match(assistant, /data-panel-mode="assistant"/);
  assert.doesNotMatch(assistant, /data-panel-height-stabilized/);
  assert.match(liveTranscriptCapsule, /data-panel-stage="encapsulated"/);
  assert.match(liveTranscriptFooter, /data-panel-mode="live-transcript"/);
  assert.match(liveTranscriptContent, /data-panel-height-stabilized="true"/);
  assert.match(assistant, /h-\[calc\(100%-1\.5rem\)\]/);
  assert.doesNotMatch(assistant, /h-fit/);
  assert.match(liveTranscriptContent, /h-fit/);
  assert.match(assistant, /data-panel-stage="content"/);
  assert.match(liveTranscriptFooter, /data-panel-stage="footer"/);
  assert.equal((assistant.match(/<section/g) || []).length, 1);
  assert.equal((liveTranscriptCapsule.match(/<section/g) || []).length, 1);
  assert.equal((liveTranscriptFooter.match(/<section/g) || []).length, 1);
  assert.equal((liveTranscriptContent.match(/<section/g) || []).length, 1);
});

test("Agent and live transcript keep a left origin through every panel stage", async () => {
  const assistant = await renderCore("assistant", true, "content", "left");
  const liveTranscriptCapsule = await renderCore("live-transcript", true, "encapsulated", "left");
  const liveTranscriptFooter = await renderCore("live-transcript", true, "footer", "left");
  const liveTranscriptContent = await renderCore("live-transcript", true, "content", "left");

  for (const markup of [
    assistant,
    liveTranscriptCapsule,
    liveTranscriptFooter,
    liveTranscriptContent,
  ]) {
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

test("Agent close keeps the same surface mounted while its expensive content fades", async () => {
  const closing = await renderClosingAssistant();

  assert.match(closing, /expanding-panel-surface-open/);
  assert.match(closing, /data-panel-mode="assistant"/);
  assert.match(closing, /data-panel-closing="true"/);
  assert.equal((closing.match(/<section/g) || []).length, 1);
});
