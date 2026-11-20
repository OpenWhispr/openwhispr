const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function renderPanel(t, settings) {
  installBrowserGlobals(t);
  globalThis.__meetingSettings = {
    meetingTranscriptionMode: "self-hosted",
    meetingRealtimeUrl: "",
    meetingRealtimeModel: "",
    openaiCompatibleRealtimeApiKey: "",
    ...settings,
  };
  t.after(() => delete globalThis.__meetingSettings);
  const server = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/stores/settingsStore": `
        const state = () => new Proxy(globalThis.__meetingSettings, {
          get: (target, key) => (key in target ? target[key] : () => {}),
        });
        export const useSettingsStore = (select) => (select ? select(state()) : state());`,
      "/hooks/usePolicy": `
        export const usePolicySnapshot = () => null;
        export const usePolicyModeOptions = (modes, _kind, mode) =>
          ({ modes, effectiveMode: mode, isModeAllowed: () => true });`,
      "/TranscriptionModelPicker": "export default () => null;",
      "/ui/ApiKeyInput": "export default () => null;",
    },
  });
  const { MeetingTranscriptionPanel } = await server.ssrLoadModule(
    "/components/settings/MeetingSettings.tsx"
  );
  return renderToStaticMarkup(React.createElement(MeetingTranscriptionPanel));
}

const urlInput = (html) => html.match(/<input[^>]*id="meeting-realtime-url"[^>]*>/)?.[0] ?? "";

test("an invalid self-hosted URL is described by its error message", async (t) => {
  const html = await renderPanel(t, { meetingRealtimeUrl: "ws://stt.example.com/v1/realtime" });
  const input = urlInput(html);
  assert.match(input, /aria-invalid="true"/);
  const describedBy = input.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy, "the invalid field names its error");
  assert.match(
    html,
    new RegExp(
      `<p id="${describedBy}"[^>]*>settingsPage\\.transcription\\.selfHostedRealtime\\.urlInvalid<`
    )
  );
});

test("a valid self-hosted URL is not described by an error", async (t) => {
  const html = await renderPanel(t, { meetingRealtimeUrl: "ws://192.168.1.20:9000/v1/realtime" });
  const input = urlInput(html);
  assert.ok(input, "the URL field renders");
  assert.doesNotMatch(input, / aria-(?:invalid|describedby)="/);
});
