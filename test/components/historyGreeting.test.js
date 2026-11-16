const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

const ITEM = {
  id: 1,
  timestamp: "2026-09-30T09:00:00.000Z",
  original_text: "Hello",
  processed_text: null,
  is_processed: false,
  processing_method: "none",
  agent_name: null,
  error: null,
};

async function mountHistoryView(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-history-greeting-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      // Echo the key and its values, so the test sees which greeting was picked and
      // what went where the name goes.
      "react-i18next": `
        const t = (key, values) => (values ? key + ":" + JSON.stringify(values) : key);
        export function useTranslation() { return { t, i18n: { language: "en" } }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/hooks/useUpcomingEvents": `
        export const useUpcomingEvents = () => ({ events: [], isLoading: false, isConnected: false });
      `,
      "/UpcomingMeetings": `export default function UpcomingMeetings() { return null; }`,
      "/ui/DictationHotkeyHint": `export default function DictationHotkeyHint() { return null; }`,
      "/ui/TranscriptionItem": `export default function TranscriptionItem() { return null; }`,
    },
  });
  const { default: HistoryView } = await vite.ssrLoadModule("/components/HistoryView.tsx");
  const noop = () => {};
  root = createRoot(container);
  const render = (props) =>
    React.act(async () =>
      root.render(
        React.createElement(HistoryView, {
          history: [],
          isLoading: false,
          hotkey: "F8",
          aiCTADismissed: true,
          setAiCTADismissed: noop,
          useCleanupModel: true,
          copyToClipboard: noop,
          deleteTranscription: noop,
          clearAllTranscriptions: noop,
          onOpenSettings: noop,
          onOpenIntegrations: noop,
          onShowAudioInFolder: noop,
          onRetryTranscription: async () => {},
          showDiscarded: false,
          onToggleDiscarded: noop,
          ...props,
        })
      )
    );
  const greeting = () =>
    findElement(
      container,
      (element) =>
        element.tagName === "H2" && element.textContent.startsWith("controlPanel.history.welcome")
    );
  return { render, greeting };
}

test("a user with no dictations yet is welcomed, not welcomed back", async (t) => {
  const { render, greeting } = await mountHistoryView(t);

  await render({ history: [] });
  assert.equal(greeting().textContent, "controlPanel.history.welcome");

  await render({ history: [ITEM] });
  assert.equal(greeting().textContent, "controlPanel.history.welcomeBack");
});

test("the greeting waits for the first load before choosing", async (t) => {
  const { render, greeting } = await mountHistoryView(t);

  await render({ history: [], isLoading: true });
  assert.match(greeting().getAttribute("class"), /\binvisible\b/);

  await render({ history: [ITEM], isLoading: false });
  assert.doesNotMatch(greeting().getAttribute("class"), /\binvisible\b/);
});

test("the user's name is isolated from the greeting's direction", async (t) => {
  const { render, greeting } = await mountHistoryView(t);

  await render({ history: [ITEM], userName: "J. Doe" });
  const name = findElement(greeting(), (element) => element.tagName === "BDI");
  assert.ok(name, "the name sits in its own <bdi>");
  assert.equal(name.textContent, "J.");
  assert.equal(name.getAttribute("dir"), "auto");
  assert.match(greeting().textContent, /^controlPanel\.history\.welcomeBackNamed:/);
});
