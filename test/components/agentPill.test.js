const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// i18n is not initialized, so labels render as their keys.

async function renderPill(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-pill-" });
  const { AgentPill } = await vite.ssrLoadModule("/components/agent/AgentPill.tsx");
  return renderToStaticMarkup(
    React.createElement(AgentPill, {
      controls: {
        waveform: false,
        thinking: false,
        waiting: false,
        buttons: ["mic", "keyboard", "close"],
      },
      recording: false,
      readLevel: () => 0,
      onAction: () => {},
      ...props,
    })
  );
}

const buttonFor = (markup, label) =>
  markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

test("a provider that can't transcribe a take turns the pill's Mic off and says why", async (t) => {
  const markup = await renderPill(t, { micUnavailableHint: "Live dictation only" });

  const mic = buttonFor(markup, "agentWindow.actions.speak");
  assert.match(mic, /disabled=""/);
  assert.match(mic, /title="Live dictation only"/);
  assert.doesNotMatch(buttonFor(markup, "agentWindow.actions.type"), /disabled=""/);
});

test("Mic stays on when voice input is available", async (t) => {
  const markup = await renderPill(t, {});

  assert.doesNotMatch(buttonFor(markup, "agentWindow.actions.speak"), /disabled=""/);
});

test("Mic is off while a take is transcribing or a reply runs", async (t) => {
  const markup = await renderPill(t, { micDisabled: true });

  assert.match(buttonFor(markup, "agentWindow.actions.speak"), /disabled=""/);
  assert.match(buttonFor(markup, "agentWindow.actions.speak"), /title="agentWindow.actions.speak"/);
});

test("waiting for an answer, the pill says so and Expand can pulse blue", async (t) => {
  const waiting = {
    waveform: false,
    thinking: false,
    waiting: true,
    buttons: ["keyboard", "expand", "close"],
  };
  const markup = await renderPill(t, { controls: waiting, expandCue: true });
  assert.match(markup, /agentWindow\.waitingForAnswer/);
  assert.match(buttonFor(markup, "agentWindow.actions.expand"), /agent-expand-cue/);
  assert.doesNotMatch(buttonFor(markup, "agentWindow.actions.type"), /agent-expand-cue/);

  const still = await renderPill(t, { controls: waiting });
  assert.doesNotMatch(still, /agent-expand-cue/);
});
