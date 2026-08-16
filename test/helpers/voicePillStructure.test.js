const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

globalThis.React = React;

const renderPill = async (state, expanded, horizontalDirection = "right") => {
  const { VoicePill } = await import("../../src/components/dictation/VoicePill.tsx");
  const markup = renderToStaticMarkup(
    React.createElement(VoicePill, {
      variant: "floating",
      state,
      expanded,
      horizontalDirection,
      getAudioLevel: () => 0,
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
