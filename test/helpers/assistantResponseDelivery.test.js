const test = require("node:test");
const assert = require("node:assert/strict");

const deliveryModule = import("../../src/helpers/assistantResponseDelivery.ts");
const RESPONSE = "Agent answer";
const PASTE_OPTIONS = {
  restoreClipboard: true,
  allowClipboardFallback: false,
};
const PASTE_DELIVERY = {
  mode: "paste",
  sessionId: "caret-session",
  ...PASTE_OPTIONS,
  plainText: true,
};

function createDeliveryHarness(pasteSuccess) {
  const pastes = [];
  const writes = [];

  return {
    pastes,
    writes,
    dependencies: {
      electronAPI: {
        async pasteAtCapturedTarget(sessionId, text, options) {
          pastes.push({ sessionId, text, options });
          return { success: pasteSuccess };
        },
        async writeClipboard(text) {
          writes.push(text);
          return { success: true };
        },
      },
      clipboard: { async writeText() {} },
    },
  };
}

test("Assistant delivery mode follows Auto-Paste and target state", async () => {
  const { createAssistantResponseDelivery } = await deliveryModule;
  const createDelivery = (autoPasteEnabled, deliverySessionId, acceptsMarkdown) =>
    createAssistantResponseDelivery({
      autoPasteEnabled,
      deliverySessionId,
      acceptsMarkdown,
      ...PASTE_OPTIONS,
    });

  assert.equal(createDelivery(false), null);
  assert.deepEqual(createDelivery(true), { mode: "clipboard" });
  assert.deepEqual(createDelivery(true, "caret-session"), PASTE_DELIVERY);
  assert.deepEqual(createDelivery(true, "caret-session", false), PASTE_DELIVERY);
  assert.deepEqual(createDelivery(true, "caret-session", true), {
    ...PASTE_DELIVERY,
    plainText: false,
  });
});

test("a captured Assistant target receives the response without replacing the clipboard", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, pastes, writes } = createDeliveryHarness(true);

  assert.deepEqual(await deliverAssistantResponse(PASTE_DELIVERY, RESPONSE, dependencies), {
    pasted: true,
    copied: false,
  });
  assert.deepEqual(pastes, [
    {
      sessionId: "caret-session",
      text: RESPONSE,
      options: PASTE_OPTIONS,
    },
  ]);
  assert.deepEqual(writes, []);
});

test("no Assistant target and a lost target both copy the completed response", async () => {
  const { deliverAssistantResponse } = await deliveryModule;

  for (const delivery of [{ mode: "clipboard" }, PASTE_DELIVERY]) {
    const { dependencies, writes } = createDeliveryHarness(false);

    assert.deepEqual(
      await deliverAssistantResponse(delivery, RESPONSE, dependencies),
      { pasted: false, copied: true },
      delivery.mode
    );
    assert.deepEqual(writes, [RESPONSE], delivery.mode);
  }
});

const MARKDOWN_RESPONSE = "**Bold** start.\n\n* item one\n* item two";
const PLAIN_RESPONSE = "Bold start.\n\n- item one\n- item two";

test("a plain-text caret target receives the response stripped of markdown", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, pastes, writes } = createDeliveryHarness(true);

  assert.deepEqual(
    await deliverAssistantResponse(PASTE_DELIVERY, MARKDOWN_RESPONSE, dependencies),
    { pasted: true, copied: false }
  );
  assert.equal(pastes[0].text, PLAIN_RESPONSE);
  assert.deepEqual(writes, []);
});

test("the clipboard fallback of a refused plain-text paste carries the same stripped text", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, writes } = createDeliveryHarness(false);

  assert.deepEqual(
    await deliverAssistantResponse(PASTE_DELIVERY, MARKDOWN_RESPONSE, dependencies),
    { pasted: false, copied: true }
  );
  assert.deepEqual(writes, [PLAIN_RESPONSE]);
});

test("an answer the strip empties is pasted raw rather than as nothing", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, pastes, writes } = createDeliveryHarness(true);
  const ONLY_SYNTAX = "---\n```\n```";

  assert.deepEqual(await deliverAssistantResponse(PASTE_DELIVERY, ONLY_SYNTAX, dependencies), {
    pasted: true,
    copied: false,
  });
  assert.equal(pastes[0].text, ONLY_SYNTAX);
  assert.deepEqual(writes, []);
});

test("a markdown-friendly caret target receives the response verbatim", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, pastes } = createDeliveryHarness(true);

  await deliverAssistantResponse(
    { ...PASTE_DELIVERY, plainText: false },
    MARKDOWN_RESPONSE,
    dependencies
  );
  assert.equal(pastes[0].text, MARKDOWN_RESPONSE);
});

test("a clipboard-only delivery keeps the response verbatim", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, writes } = createDeliveryHarness(false);

  await deliverAssistantResponse({ mode: "clipboard" }, MARKDOWN_RESPONSE, dependencies);
  assert.deepEqual(writes, [MARKDOWN_RESPONSE]);
});

const LITERAL_CONTENT_CASES = [
  {
    name: "inline code at line start",
    content: "```hello```\nThis is the next paragraph.",
    plainText: "hello\nThis is the next paragraph.",
  },
  {
    name: "relative Windows paths",
    content: String.raw`Open src\__tests__\index.test.ts and run dir src\*.ts.`,
    plainText: String.raw`Open src\__tests__\index.test.ts and run dir src\*.ts.`,
  },
  {
    name: "escaped punctuation in emphasis",
    content: String.raw`*Use \* for wildcard matches.*`,
    plainText: "Use * for wildcard matches.",
  },
  {
    name: "fenced code indentation",
    content: "```python\n    if enabled:\n        run()\n    return value\n```",
    plainText: "    if enabled:\n        run()\n    return value",
  },
  {
    name: "POSIX paths",
    content: "Open /tmp/__init__.py and ~/__work__/code.",
    plainText: "Open /tmp/__init__.py and ~/__work__/code.",
  },
  {
    name: "parenthesized URL destinations",
    content: "[Source](https://example.com/a_(b)/__init__.py)",
    plainText: "Source (https://example.com/a_(b)/__init__.py)",
  },
  {
    name: "backticks inside inline code",
    content: "Run ``echo `whoami` ``.",
    plainText: "Run echo `whoami` .",
  },
  {
    name: "empty table edge cells",
    content: "| | 2025 | 2026 |\n|---|---|---|\n| Revenue | 100 | |",
    plainText: "\t2025\t2026\nRevenue\t100\t",
  },
  {
    name: "URL destinations",
    content: "[**Source**](https://example.com/pkg/__init__.py)",
    plainText: "Source (https://example.com/pkg/__init__.py)",
  },
  {
    name: "Windows paths",
    content: [
      String.raw`Open \\fileserver\finance\budget.xlsx and C:\_archive\report.txt.`,
      String.raw`**Read** C:\My Documents\_archive\report.txt.`,
    ].join("\n"),
    plainText: [
      String.raw`Open \\fileserver\finance\budget.xlsx and C:\_archive\report.txt.`,
      String.raw`Read C:\My Documents\_archive\report.txt.`,
    ].join("\n"),
  },
  {
    name: "nested code fences",
    content: ["````markdown", "```js", 'const label = "**draft**";', "```", "````"].join("\n"),
    plainText: ["```js", 'const label = "**draft**";', "```"].join("\n"),
  },
  {
    name: "escaped table pipes",
    content: "| Choice | Meaning |\n| --- | --- |\n| A \\| B | either choice |",
    plainText: "Choice\tMeaning\nA | B\teither choice",
  },
];

for (const example of LITERAL_CONTENT_CASES) {
  for (const pasteSuccess of [true, false]) {
    test(`${example.name} survive ${pasteSuccess ? "paste" : "clipboard fallback"}`, async () => {
      const { createAssistantResponseDelivery, deliverAssistantResponse } = await deliveryModule;
      for (const acceptsMarkdown of [false, true]) {
        const { dependencies, pastes, writes } = createDeliveryHarness(pasteSuccess);
        const delivery = createAssistantResponseDelivery({
          autoPasteEnabled: true,
          deliverySessionId: "caret-session",
          acceptsMarkdown,
          ...PASTE_OPTIONS,
        });
        const expected = acceptsMarkdown ? example.content : example.plainText;

        assert.deepEqual(await deliverAssistantResponse(delivery, example.content, dependencies), {
          pasted: pasteSuccess,
          copied: !pasteSuccess,
        });
        assert.deepEqual(pastes, [
          { sessionId: "caret-session", text: expected, options: PASTE_OPTIONS },
        ]);
        assert.deepEqual(writes, pasteSuccess ? [] : [expected]);
      }
    });
  }

  test(`${example.name} stay verbatim for clipboard-only delivery`, async () => {
    const { deliverAssistantResponse } = await deliveryModule;
    const { dependencies, pastes, writes } = createDeliveryHarness(false);
    await deliverAssistantResponse({ mode: "clipboard" }, example.content, dependencies);
    assert.deepEqual(pastes, []);
    assert.deepEqual(writes, [example.content]);
  });
}
