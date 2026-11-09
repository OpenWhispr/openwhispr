const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHappyDom,
} = require("../lib/rendererTestHarness");

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

test("assistant and dictation render the same live waveform from quiet speech through loud peaks", async (t) => {
  let root;
  t.after(() => root && React.act(() => root.unmount()));
  const dom = await installHappyDom(t);
  const frames = new Map();
  let frameId = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-waveform-" });
  const { AgentPill } = await vite.ssrLoadModule("/components/agent/AgentPill.tsx");
  const { VoicePill } = await vite.ssrLoadModule("/components/dictation/VoicePill.tsx");
  let level = 0;
  const getLevel = () => level;
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const { createRoot } = require("react-dom/client");
  root = createRoot(host);
  await React.act(() =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "div",
          { id: "assistant" },
          React.createElement(AgentPill, {
            controls: {
              waveform: true,
              thinking: false,
              waiting: false,
              buttons: ["stop", "keyboard", "close"],
            },
            recording: true,
            readLevel: getLevel,
            onAction() {},
          })
        ),
        React.createElement(VoicePill, {
          variant: "floating",
          state: "recording",
          expanded: true,
          horizontalDirection: "right",
          getAudioLevel: getLevel,
        })
      )
    )
  );
  const assistantBars = () => [...host.querySelectorAll("#assistant [aria-hidden='true'] > div")];
  const dictationBars = () => [
    ...host.querySelectorAll(".voice-pill-waveform > div:last-child > div"),
  ];
  let now = 0;
  for (const sample of [0, 0.01, 0.03, 0.12, 0.02, 0.08, 0.15, 0, 0.04, 0.1, 0.02]) {
    level = sample;
    now += 80;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((paint) => paint(now));
    assert.equal(assistantBars().length, 11);
    assert.deepEqual(
      assistantBars().map((bar) => bar.style.height),
      dictationBars().map((bar) => bar.style.height)
    );
  }
  assert.ok(assistantBars().some((bar) => parseFloat(bar.style.height) > 20));
  assert.equal(
    host.querySelector("#assistant > div > :first-child").tagName,
    "DIV",
    "the waveform uses the old logo's space"
  );
});
