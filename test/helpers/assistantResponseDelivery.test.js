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

// On niri, wlroots and Hyprland without wl-copy (#2621), the app the user is in
// can't read the copy, so the panel offers its Copy button instead of "Copied".
test("a copy only XWayland apps can read is not reported as copied", async () => {
  const { deliverAssistantResponse } = await deliveryModule;

  for (const delivery of [{ mode: "clipboard" }, PASTE_DELIVERY]) {
    const { dependencies, writes } = createDeliveryHarness(false);
    const rendererWrites = [];
    dependencies.electronAPI.writeClipboard = async (text) => {
      writes.push(text);
      return { success: true, xwaylandOnly: true };
    };
    dependencies.clipboard = { writeText: async (text) => rendererWrites.push(text) };

    assert.deepEqual(
      await deliverAssistantResponse(delivery, RESPONSE, dependencies),
      { pasted: false, copied: false },
      delivery.mode
    );
    assert.deepEqual(writes, [RESPONSE], delivery.mode);
    assert.deepEqual(rendererWrites, [], `${delivery.mode}: no second write to the same clipboard`);
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

test("a paste delivery keeps the kind of app the caret is in", async () => {
  const { createAssistantResponseDelivery } = await deliveryModule;
  const delivery = createAssistantResponseDelivery({
    autoPasteEnabled: true,
    deliverySessionId: "caret-session",
    appCategory: "work",
    ...PASTE_OPTIONS,
  });
  assert.equal(delivery.appCategory, "work");
});

const DASHED_RESPONSE = [
  "hey, how's the figma config\u2014\u2014going ok?",
  "ask your issuer\u00a0\u2014 they know",
  "want lunch? \u2014i'm free",
  "yes, \u2014 really",
  "so \u2014, yeah",
  "wait\u2014",
  "",
  " \u2014\u2014 one more",
].join("\n");

test("an answer typed in the user's Tone & Style, and its clipboard fallback, lose their em dashes", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const toneDelivery = { ...PASTE_DELIVERY, appCategory: "personal" };
  const expected = [
    "hey, how's the figma config, going ok?",
    "ask your issuer, they know",
    "want lunch? i'm free",
    "yes, really",
    "so, yeah",
    "wait",
    "",
    "one more",
  ].join("\n");

  const pasted = createDeliveryHarness(true);
  await deliverAssistantResponse(toneDelivery, DASHED_RESPONSE, pasted.dependencies);
  assert.equal(pasted.pastes[0].text, expected);

  const refused = createDeliveryHarness(false);
  await deliverAssistantResponse(toneDelivery, DASHED_RESPONSE, refused.dependencies);
  assert.deepEqual(refused.writes, [expected]);
});

test("without Tone & Style an answer keeps its em dashes", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const { dependencies, pastes } = createDeliveryHarness(true);

  await deliverAssistantResponse(PASTE_DELIVERY, DASHED_RESPONSE, dependencies);
  assert.equal(pastes[0].text, DASHED_RESPONSE);
});

test("em dashes that carry meaning survive the Tone & Style strip", async () => {
  const { deliverAssistantResponse } = await deliveryModule;
  const toneDelivery = { ...PASTE_DELIVERY, plainText: false, appCategory: "other" };
  const cases = [
    // Ranges take an en dash rather than turning into a list.
    ["from 1990\u20142000", "from 1990\u20132000"],
    ["pages 10 \u2014 20", "pages 10 \u2013 20"],
    ["Q3\u2014Q4 plan", "Q3\u2013Q4 plan"],
    ["call at 5 \u2014 or later", "call at 5, or later"],
    // Scripts that use the dash in their grammar keep it.
    ["Это \u2014 книга", "Это \u2014 книга"],
    ["«\u2014 Да, \u2014 сказал он.»", "«\u2014 Да, \u2014 сказал он.»"],
    ["我们\u2014\u2014就是你们", "我们\u2014\u2014就是你们"],
    // Brackets and quotes count as punctuation.
    ["the end \u2014)", "the end)"],
    ["(\u2014 a note)", "(a note)"],
    ['"done" \u2014 then', '"done", then'],
    ["wait \u2014 \u2014 what", "wait, what"],
    // Code and links are left as written.
    ["run `a\u2014b` now", "run `a\u2014b` now"],
    ["```\nx\u2014y\n```", "```\nx\u2014y\n```"],
    ["`npm test` \u2014 then", "`npm test`, then"],
    ["see https://example.com/a\u2014b", "see https://example.com/a\u2014b"],
  ];

  for (const [input, expected] of cases) {
    const { dependencies, pastes } = createDeliveryHarness(true);
    await deliverAssistantResponse(toneDelivery, input, dependencies);
    assert.equal(pastes[0].text, expected, input);
  }
});
