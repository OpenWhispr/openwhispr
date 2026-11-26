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

test("a take's pill shows the call pill's four Sound bars, rising with the microphone while it records and sinking back after", async (t) => {
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
  const runFrames = (count) => {
    for (let i = 0; i < count; i++) {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((paint) => paint(i * 16));
    }
  };
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-waveform-" });
  const { AgentPill } = await vite.ssrLoadModule("/components/agent/AgentPill.tsx");
  const readLevel = () => 0.1;
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const { createRoot } = require("react-dom/client");
  root = createRoot(host);
  const render = (recording) =>
    React.act(() =>
      root.render(
        React.createElement(AgentPill, {
          controls: {
            waveform: true,
            thinking: false,
            waiting: false,
            buttons: ["stop", "keyboard", "close"],
          },
          recording,
          readLevel,
          onAction() {},
        })
      )
    );
  await render(true);
  const bars = host.querySelector("[aria-hidden='true']");
  const lifts = () =>
    [0, 1, 2, 3].map((index) => Number(bars.style.getPropertyValue(`--voice-bar-${index}`) || 0));
  assert.equal(bars.querySelectorAll("span.w-0\\.5").length, 4);
  const slot = host.querySelector(":scope > div > :first-child");
  assert.ok(slot.contains(bars), "the bars lead the pill");
  runFrames(20);
  assert.ok(
    lifts().some((lift) => lift > 0.05),
    `they rise with the microphone: ${lifts()}`
  );

  await render(false);
  runFrames(1);
  assert.ok(
    lifts().some((lift) => lift > 0.05),
    `and sink back from there, not at once: ${lifts()}`
  );
  runFrames(120);
  assert.ok(
    lifts().every((lift) => lift <= 0.001),
    `then come to rest: ${lifts()}`
  );
});
