const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

async function mountChatMessages(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__markdownRenders;
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  globalThis.__markdownRenders = 0;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-message-rendering-test-",
    mockModules: {
      "/hooks/useStickToBottom": `
        export const useStickToBottom = () => ({ scrollRef: { current: null } });
      `,
      "/ui/MarkdownRenderer": `
        export function MarkdownRenderer({ content }) {
          globalThis.__markdownRenders += 1;
          return content;
        }
      `,
    },
  });
  const { ChatMessages } = await vite.ssrLoadModule("/components/chat/ChatMessages.tsx");
  root = createRoot(container);
  const render = (props) =>
    React.act(async () => root.render(React.createElement(ChatMessages, props)));
  return { container, render };
}

const MESSAGES = [
  { id: "q", role: "user", content: "Summarize the notes", isStreaming: false },
  { id: "a", role: "assistant", content: "Here is **the summary**.", isStreaming: false },
];

// A note re-renders its chat on every keystroke in the note (or in the composer); the
// replies must not re-parse their Markdown each time.
test("re-rendering the conversation with the same messages doesn't re-render the replies", async (t) => {
  const { render } = await mountChatMessages(t);

  await render({ messages: MESSAGES, scrollClassName: "a" });
  const initialRenders = globalThis.__markdownRenders;
  assert.ok(initialRenders > 0);

  await render({ messages: MESSAGES, scrollClassName: "b" });
  assert.equal(globalThis.__markdownRenders, initialRenders);

  // A streaming reply still updates.
  await render({
    messages: [MESSAGES[0], { ...MESSAGES[1], content: "Here is **the summary**. More" }],
    scrollClassName: "b",
  });
  assert.equal(globalThis.__markdownRenders, initialRenders + 1);
});

test("a question typed on several lines keeps its line breaks", async (t) => {
  const { container, render } = await mountChatMessages(t);

  await render({
    messages: [{ id: "q", role: "user", content: "line one\nline two", isStreaming: false }],
  });
  const text = findElement(
    container,
    (element) => element.tagName === "SPAN" && element.textContent === "line one\nline two"
  );
  assert.ok(text);
  assert.match(text.getAttribute("class") ?? "", /(^|\s)whitespace-pre-wrap(\s|$)/);
});

// A classified provider failure (Task 3's describeProviderError) rides along on the
// message as `error`; the reply shows an Open Settings link and a details disclosure.
test("a reply with a classified error shows an Open Settings link and technical details", async (t) => {
  const { container, render } = await mountChatMessages(t);

  await render({
    messages: [
      {
        id: "a",
        role: "assistant",
        content: "Error: OpenAI rejected your API key.",
        isStreaming: false,
        error: { settingsTarget: "llms", technicalDetails: { provider: "OpenAI", status: 401 } },
      },
    ],
  });

  assert.match(container.textContent, /OpenAI rejected your API key\./);
  const settingsButton = findElement(
    container,
    (element) => element.tagName === "BUTTON" && /providerErrors\.openSettings/.test(element.textContent)
  );
  assert.ok(settingsButton, "shows the Open Settings affordance");
  assert.match(container.textContent, /reasoning\.enterprise\.technicalDetails\.title/);
  assert.match(container.textContent, /OpenAI/);
  assert.match(container.textContent, /401/);
});

test("a reply with no error shows neither the settings link nor technical details", async (t) => {
  const { container, render } = await mountChatMessages(t);

  await render({
    messages: [{ id: "a", role: "assistant", content: "All good.", isStreaming: false }],
  });

  assert.doesNotMatch(container.textContent, /providerErrors\.openSettings/);
  assert.doesNotMatch(container.textContent, /reasoning\.enterprise\.technicalDetails\.title/);
});
