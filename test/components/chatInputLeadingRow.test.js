const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadChatInput(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-input-leading-row-test-",
    mockModules: {
      "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
      "/useVoiceDraft": `export const useVoiceDraft = () => ({ status: "idle" });`,
      "/stores/meetingRecordingStore": `
        export const getMicAnalyser = () => null;
        export const useMeetingRecordingStore = { getState: () => ({ currentMicLevel: 0 }) };
      `,
    },
  });
  const { ChatInput } = await vite.ssrLoadModule("/components/chat/ChatInput.tsx");
  return (props) =>
    renderToStaticMarkup(
      React.createElement(ChatInput, {
        agentState: "idle",
        partialTranscript: "",
        onTextSubmit: () => {},
        variant: "assistant",
        expandOnFocus: true,
        ...props,
      })
    );
}

const FOCUS_EXPANSION = "focus-within:h-[clamp";
const textareaClass = (markup) => markup.match(/<textarea[^>]*class="([^"]*)"/)[1];

test(
  "a leading row sits inside the composer above the text field and turns off the focus expansion",
  async (t) => {
    const render = await loadChatInput(t);
    // Control: without a row, the composer grows when focused.
    assert.ok(render({}).includes(FOCUS_EXPANSION));

    const row = React.createElement("span", { "data-leading-row": "" }, "Meeting prep");
    const markup = render({ leadingRow: row });

    const composer = markup.indexOf("rounded-3xl");
    const leadingRow = markup.indexOf("data-leading-row");
    assert.ok(composer >= 0 && leadingRow > composer, "the row is inside the composer");
    assert.ok(leadingRow < markup.indexOf("<textarea"), "the row comes before the text field");
    assert.ok(!markup.includes(FOCUS_EXPANSION));
    assert.match(textareaClass(markup), /\bmax-h-32\b/);
    assert.doesNotMatch(textareaClass(markup), /\bmax-h-none\b/);
  }
);
