const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};

async function loadDemoStep(t) {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-onboarding-demo-step-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t(key) { return key; } };
        }
      `,
      "canvas-confetti": `export default { create() { return Object.assign(() => {}, { reset() {} }); } };`,
      "onboarding-founder.webp": `export default "founder.webp";`,
      "icons/gmail.svg": `export default "gmail.svg";`,
    },
  });
  const { default: DemoStep } = await vite.ssrLoadModule("/components/onboarding/DemoStep.tsx");
  return DemoStep;
}

const labels = {
  placeholder: "Your dictation will appear here…",
  listeningLabel: "Listening…",
  processingLabel: "Turning your voice into text…",
  stopLabel: "Stop",
  retryLabel: "Retry",
  onSuccessChange: noop,
};

test("the assistant demo stages the request as a mail thread with a voice reply", async (t) => {
  const DemoStep = await loadDemoStep(t);
  const markup = renderToStaticMarkup(
    React.createElement(DemoStep, {
      ...labels,
      kind: "assistant",
      firstMessage: "Would you be up for a quick coffee next week?",
      secondMessage: "Try saying: “Reply and suggest a few times.”",
    })
  );

  // The card is what screen context photographs, so the sender and the ask are
  // real text, not artwork.
  assert.match(markup, /onboarding\.rehaul\.assistantDemo\.email\.subject/);
  assert.match(markup, /onboarding\.rehaul\.assistantDemo\.email\.senderName/);
  assert.match(markup, /onboarding\.rehaul\.assistantDemo\.email\.recipient/);
  assert.match(markup, /Would you be up for a quick coffee next week\?/);
  assert.match(markup, /src="gmail\.svg"/);
  // The composer opens on the suggested request and takes the reply in the
  // user's own writing direction.
  assert.match(
    markup,
    /<textarea[^>]*dir="auto"[^>]*placeholder="Try saying: “Reply and suggest a few times\.”"/
  );
  assert.match(markup, /aria-label="onboarding\.rehaul\.assistantDemo\.email\.reply"/);
});

test("the dictation demo keeps its chat bubbles and no mail chrome", async (t) => {
  const DemoStep = await loadDemoStep(t);
  const markup = renderToStaticMarkup(
    React.createElement(DemoStep, {
      ...labels,
      kind: "dictation",
      firstMessage: "Hi, I am Gabe",
      secondMessage: "Try saying something",
    })
  );

  assert.match(markup, /src="founder\.webp"/);
  assert.doesNotMatch(markup, /gmail\.svg/);
  assert.doesNotMatch(markup, /assistantDemo\.email/);
});
