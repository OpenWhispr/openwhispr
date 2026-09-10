const { test, describe } = require("node:test");
const assert = require("node:assert");

const load = () => import("../../src/helpers/geminiResponse.js");

describe("extractGeminiText", () => {
  test("returns trimmed text for a normal single text part", async () => {
    const { extractGeminiText } = await load();
    const candidate = {
      content: {
        parts: [{ text: "  cleaned up transcript  " }],
      },
    };
    assert.strictEqual(extractGeminiText(candidate), "cleaned up transcript");
  });

  test("joins multiple text parts into a single string", async () => {
    const { extractGeminiText } = await load();
    const candidate = {
      content: {
        parts: [{ text: "First paragraph.\n\n" }, { text: "Second paragraph." }],
      },
    };
    assert.strictEqual(extractGeminiText(candidate), "First paragraph.\n\nSecond paragraph.");
  });

  test("skips thought parts and returns subsequent text parts", async () => {
    const { extractGeminiText } = await load();
    const candidate = {
      content: {
        parts: [
          { thought: true, text: "Let me think about this transcript..." },
          { text: "Here is the cleaned result." },
        ],
      },
    };
    assert.strictEqual(extractGeminiText(candidate), "Here is the cleaned result.");
  });

  test("returns null when only thought parts are present", async () => {
    const { extractGeminiText } = await load();
    const candidate = {
      content: {
        parts: [{ thought: true, text: "Thinking only..." }],
      },
    };
    assert.strictEqual(extractGeminiText(candidate), null);
  });

  test("returns null when parts array is empty", async () => {
    const { extractGeminiText } = await load();
    assert.strictEqual(extractGeminiText({ content: { parts: [] } }), null);
  });

  test("returns null for malformed or missing candidate", async () => {
    const { extractGeminiText } = await load();
    assert.strictEqual(extractGeminiText(null), null);
    assert.strictEqual(extractGeminiText(undefined), null);
    assert.strictEqual(extractGeminiText({}), null);
    assert.strictEqual(extractGeminiText({ content: null }), null);
    assert.strictEqual(extractGeminiText({ content: { parts: "invalid" } }), null);
  });

  test("skips parts without text or with empty text", async () => {
    const { extractGeminiText } = await load();
    const candidate = {
      content: {
        parts: [{ inlineData: {} }, { text: "" }, { text: "Valid text" }],
      },
    };
    assert.strictEqual(extractGeminiText(candidate), "Valid text");
  });
});
