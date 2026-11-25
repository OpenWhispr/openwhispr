const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const fs = require("node:fs");
const path = require("node:path");
const {
  createRendererServer,
  installBrowserGlobals,
  installHappyDom,
} = require("../lib/rendererTestHarness");

// The call's pill module, with the English strings.
async function loadPill(t) {
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-voice-pill-" });
  const [{ default: i18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!i18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await i18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }
  return vite.ssrLoadModule("/components/agent/VoicePill.tsx");
}

const noop = () => {};
const PILL_PROPS = {
  status: "listening",
  readLevel: () => 0,
  waveformActive: true,
  micMuted: false,
  sessionControl: "end",
  settingsOpen: false,
  onSettings: noop,
  onTranscript: noop,
  onMic: noop,
  onEnd: noop,
  onStopReply: noop,
  onLeave: noop,
};

async function renderPill(t, props) {
  installBrowserGlobals(t);
  const { VoicePill } = await loadPill(t);
  return renderToStaticMarkup(React.createElement(VoicePill, { ...PILL_PROPS, ...props }));
}

// The pill mounted in a real DOM, with node's mock timers for the cap's words.
async function mountPill(t, props) {
  let root = null;
  t.after(() => root && React.act(async () => root.unmount()));
  const happyWindow = await installHappyDom(t);
  const { VoicePill } = await loadPill(t);
  const { createRoot } = require("react-dom/client");
  const host = happyWindow.document.createElement("div");
  root = createRoot(host);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const render = (next) =>
    React.act(async () =>
      root.render(React.createElement(VoicePill, { ...PILL_PROPS, waveformActive: false, ...next }))
    );
  await render(props);
  const tick = () => React.act(async () => t.mock.timers.runAll());
  return { host, render, tick };
}

test("the compact pill expands to the transcript, and the transcript's pill minimizes it", async (t) => {
  const compact = await renderPill(t, {});
  assert.match(compact, /aria-label="Expand"/);
  assert.doesNotMatch(compact, /aria-label="Minimize"/);
  const inModal = await renderPill(t, { inModal: true });
  assert.match(inModal, /aria-label="Minimize"/);
  assert.doesNotMatch(inModal, /aria-label="Expand"/);
});

test("a stopped call shows Back to typing in place of its controls", async (t) => {
  const stopped = await renderPill(t, { status: "stopped", inModal: true });
  assert.match(stopped, />Back to typing</, "said in words, not only on hover");
  for (const label of ["Settings", "Minimize", "Turn microphone off", "End call"]) {
    assert.doesNotMatch(stopped, new RegExp(`aria-label="${label}"`));
  }
});

test("while a turn works, the cap reads Working with one, two, then three dots, from none each turn", async (t) => {
  const view = await mountPill(t, { status: "working" });
  const cap = () => view.host.querySelector("[role=status]");
  const dotsShown = () =>
    [...cap().querySelectorAll('[aria-hidden="true"] > span')].filter(
      (dot) => !dot.classList.contains("opacity-0")
    ).length;
  assert.equal(
    cap().textContent,
    "Working...",
    "every dot keeps its place, so the word never shifts"
  );
  const counts = [dotsShown()];
  for (let step = 0; step < 4; step += 1) {
    await view.tick();
    counts.push(dotsShown());
  }
  assert.deepEqual(counts, [0, 1, 2, 3, 0]);

  await view.tick();
  await view.render({ status: "working", notice: "Copied" });
  assert.equal(cap().textContent, "Copied");
  await view.render({ status: "speaking" });
  assert.equal(cap().textContent, "Speaking");
  await view.render({ status: "working" });
  assert.equal(dotsShown(), 0);
});

test("the bars follow sound only while listening or speaking, sink back gradually after, and shimmer while the turn works", async (t) => {
  // Loud sound throughout, so any state that followed it would lift the bars.
  const sound = { waveformActive: true, readLevel: () => 0.1 };
  const view = await mountPill(t, { status: "working", ...sound });
  const pill = view.host.querySelector("[data-voice-pill]");
  const bars = () => [...pill.querySelectorAll("span.w-0\\.5")];
  const lifts = () =>
    bars().map((_, index) => Number(pill.style.getPropertyValue(`--voice-bar-${index}`) || 0));
  const shimmer = () =>
    bars().map((bar) =>
      bar.classList.contains("voice-bar-shimmer") ? bar.style.animationDelay : null
    );
  const wait = (ms) => React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));
  for (const status of ["working", "sendingEmail", "sendingMessage"]) {
    await view.render({ status, ...sound });
    await wait(200);
    assert.deepEqual(lifts(), [0, 0, 0, 0], `${status}: at rest`);
    assert.deepEqual(
      shimmer(),
      ["0ms", "200ms", "400ms", "600ms"],
      `${status}: a blue wave across the bars`
    );
  }
  for (const status of ["starting", "micOff", "waiting", "stopped"]) {
    await view.render({ status, ...sound });
    await wait(200);
    assert.deepEqual(lifts(), [0, 0, 0, 0], `${status}: at rest`);
    assert.deepEqual(shimmer(), [null, null, null, null], `${status}: no shimmer`);
  }
  for (const status of ["listening", "speaking"]) {
    await view.render({ status, ...sound });
    await wait(300);
    assert.deepEqual(shimmer(), [null, null, null, null], `${status}: no shimmer`);
    assert.ok(
      lifts().some((lift) => lift > 0.05),
      `${status}: the bars follow the sound: ${lifts()}`
    );
  }
  await view.render({ status: "working", ...sound });
  assert.ok(
    lifts().some((lift) => lift > 0.05),
    `they sink back from where they were: ${lifts()}`
  );
  await wait(2000);
  assert.ok(
    lifts().every((lift) => lift <= 0.001),
    `and come to rest: ${lifts()}`
  );
  assert.ok(
    bars().every((bar) => bar.style.height.startsWith("calc(8px + 20px")),
    "every bar keeps the same resting size"
  );
});
