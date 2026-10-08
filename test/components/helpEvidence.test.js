const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

const path = "/help/dictation/hotkeys";
const source = {
  title: "Shortcuts",
  path,
  url: `https://docs.openwhispr.com${path}`,
  source: "bundled",
  reason: "unavailable",
};
const call = (metadata = {}) => ({
  id: "help",
  name: "grounded_product_help",
  arguments: "{}",
  status: "completed",
  metadata: {
    kind: "grounded-help",
    sources: [source],
    facts: [{ label: "Activation mode", value: "Hold" }],
    readAt: "2026-10-07T12:00:00.000Z",
    ...metadata,
  },
});

test("help evidence accepts only completed app metadata and exact allowlisted source links", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { extractHelpEvidence } = await vite.ssrLoadModule("/components/chat/helpEvidence.ts");
  assert.equal(extractHelpEvidence([{ ...call(), name: "search_web" }]), null);
  assert.equal(extractHelpEvidence([{ ...call(), status: "error" }]), null);
  assert.equal(extractHelpEvidence([call({ kind: "model-help" })]), null);
  const bad = [
    { ...source, url: "https://evil.example" },
    { ...source, path: "/help/dictation/../private" },
    { ...source, path: "/help/dictation/hotkeys?token=secret" },
    { ...source, url: `${source.url}#generated` },
    { ...source, source: "claimed-live" },
  ];
  assert.equal(extractHelpEvidence([call({ sources: bad })]).sources.length, 0);
  const evidence = extractHelpEvidence([call({ sources: [...bad, source, source] })]);
  assert.equal(evidence.sources.length, 1);
  assert.equal(evidence.sources[0].url, source.url);
  assert.deepEqual(evidence.facts, [{ key: "activationMode", value: "Hold" }]);
});

test("help evidence shows built-in guidance, per-source fallback, canonical facts, and real links in Chat", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    mockModules: {
      "/ui/MarkdownRenderer": "export function MarkdownRenderer({content}) { return content; }",
    },
  });
  const { ChatMessage } = await vite.ssrLoadModule("/components/chat/ChatMessage.tsx");
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(ChatMessage, {
        messageId: "answer",
        role: "assistant",
        content: "Reviewed answer",
        isStreaming: false,
        toolCalls: [call()],
      })
    )
  );
  assert.match(container.textContent, /productHelp.guidance/);
  assert.match(container.textContent, /productHelp.reason.unavailable/);
  assert.match(container.textContent, /productHelp.sourceStatus.bundled/);
  assert.match(container.textContent, /settingsPage.general.hotkey.activationModecommon.hold/);
  assert.doesNotMatch(container.textContent, /grounded_product_help/);
  const facts = findElement(container, (element) => element.tagName === "DETAILS");
  assert.equal(facts.getAttribute("open"), null);
  const link = findElement(container, (element) => element.tagName === "A");
  assert.equal(link.getAttribute("href"), source.url);
});

test("live and fallback sources keep separate statuses; malformed facts and dates are omitted", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { extractHelpEvidence } = await vite.ssrLoadModule("/components/chat/helpEvidence.ts");
  const live = {
    ...source,
    path: "/help/dictation/hold-or-tap",
    url: "https://docs.openwhispr.com/help/dictation/hold-or-tap",
    source: "live",
  };
  const evidence = extractHelpEvidence([
    call({
      sources: [source, live],
      facts: [{ label: "bad", value: { secret: "x" } }],
      readAt: "not a timestamp",
    }),
  ]);
  assert.equal(evidence.sources[0].reason, "unavailable");
  assert.equal(evidence.sources[1].reason, null);
  assert.equal(evidence.sources[1].source, "live");
  assert.deepEqual(evidence.facts, []);
  assert.equal(evidence.readAt, null);
});

test("Chat explicit Copy strips help markup and keeps settings and fallback links", async (t) => {
  let root;
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let copied;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        copied = text;
      },
    },
  });
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else delete navigator.clipboard;
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t);
  const { ChatMessage } = await vite.ssrLoadModule("/components/chat/ChatMessage.tsx");
  root = createRoot(container);
  const content = require("../../src/config/productHelpTopics.json").microphone.text;
  const render = (toolCalls) =>
    React.act(async () =>
      root.render(
        React.createElement(ChatMessage, {
          messageId: "help",
          role: "assistant",
          content,
          isStreaming: false,
          toolCalls,
        })
      )
    );
  await render([call()]);
  assert.ok(findElement(container, (el) => el.tagName === "OL"));
  assert.ok(findElement(container, (el) => el.tagName === "STRONG"));
  const button = findElement(container, (el) => el.tagName === "BUTTON");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await React.act(async () => button.dispatchEvent({ type: "click", bubbles: true }));
  assert.match(copied, /1\. Choose your microphone\./);
  assert.doesNotMatch(copied, /\*\*/);
  assert.match(copied, /productHelp.reason.unavailable/);
  assert.match(copied, /settingsPage.general.hotkey.activationMode: common.hold/);
  assert.ok(copied.includes(source.url));
  // Ordinary model messages retain their existing raw Markdown copy behavior.
  await render(undefined);
  await React.act(async () => button.dispatchEvent({ type: "click", bubbles: true }));
  assert.equal(copied, content);
  await React.act(async () => t.mock.timers.tick(1500));
});

test("current tool evidence combines citations without retaining settings snapshots", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { extractHelpEvidence } = await vite.ssrLoadModule("/components/chat/helpEvidence.ts");
  const evidence = extractHelpEvidence([
    {
      ...call({ kind: "product-help", facts: [{ key: "dictationKey", value: "F9" }] }),
      name: "search_openwhispr_help",
    },
    {
      ...call({ kind: "product-help", sources: [], settingsRead: true }),
      name: "get_openwhispr_context",
    },
  ]);
  assert.equal(evidence.sources.length, 1);
  assert.deepEqual(evidence.facts, []);
  assert.equal(evidence.readAt, "2026-10-07T12:00:00.000Z");
});

test("legacy facts use stable keys, omit private devices and unknown OS, and format human values", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { extractHelpEvidence } = await vite.ssrLoadModule("/components/chat/helpEvidence.ts");
  const { helpFactLabel, helpFactValue } = await vite.ssrLoadModule(
    "/components/chat/helpEvidenceText.ts"
  );
  const evidence = extractHelpEvidence([
    call({
      facts: [
        { label: "Selected microphone", value: "Private user's microphone" },
        { label: "OS version", value: "Unknown" },
        { label: "Microphone selection", value: "System Default" },
        { label: "Microphone permission", value: "granted" },
        { key: "dictationKey", value: "RightCommand" },
      ],
    }),
  ]);
  assert.deepEqual(
    evidence.facts.map((fact) => fact.key),
    ["microphoneSelectionMode", "microphonePermission", "dictationKey"]
  );
  const translate = (key) => key;
  assert.notEqual(
    helpFactLabel("microphonePermission", translate),
    helpFactLabel("microphoneSelectionMode", translate)
  );
  assert.equal(helpFactValue("RightCommand", translate, "dictationKey"), "Right Cmd");
  assert.equal(
    helpFactValue("granted", translate, "microphonePermission"),
    "productHelp.permissionGranted"
  );
  assert.equal(helpFactValue("whisper-local", translate, "dictationEngine"), "Whisper");
  assert.equal(helpFactValue("private-provider-id", translate, "chatProvider"), "common.unknown");
});
