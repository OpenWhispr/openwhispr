const test = require("node:test");
const assert = require("node:assert/strict");

test("Groq prompt budgets use the parsed endpoint hostname", async (t) => {
  const {
    dictionaryPromptLimit,
    GROQ_PROMPT_BYTES,
    WHISPER_PROMPT_CHARS,
    TRANSCRIBE_PROMPT_CHARS,
  } = await import("../../src/utils/dictionaryPromptCap.js");
  const cases = [
    ["exact host", "https://api.groq.com/openai/v1/audio/transcriptions", true],
    ["uppercase host", "https://API.GROQ.COM/openai/v1/audio/transcriptions", true],
    ["path impostor", "https://stt.example/api.groq.com/audio/transcriptions", false],
    ["query impostor", "https://stt.example/audio/transcriptions?upstream=api.groq.com", false],
    ["userinfo impostor", "https://api.groq.com@stt.example/audio/transcriptions", false],
    ["subdomain", "https://proxy.api.groq.com/audio/transcriptions", false],
    ["suffix host", "https://api.groq.com.example/audio/transcriptions", false],
    ["malformed URL", "https://api.groq.com:invalid/audio/transcriptions", false],
    ["scheme-less URL", "api.groq.com/audio/transcriptions", false],
    ["empty endpoint", "", false],
    ["undefined endpoint", undefined, false],
    ["null endpoint", null, false],
  ];

  for (const [name, endpoint, groq] of cases) {
    await t.test(name, () => {
      for (const [model, otherLimit] of [
        ["whisper-1", WHISPER_PROMPT_CHARS],
        ["gpt-4o-mini-transcribe", TRANSCRIBE_PROMPT_CHARS],
      ]) {
        assert.equal(
          dictionaryPromptLimit({ provider: "custom", endpoint, model }),
          groq ? GROQ_PROMPT_BYTES : otherLimit
        );
        assert.equal(
          dictionaryPromptLimit({ provider: "groq", endpoint, model }),
          GROQ_PROMPT_BYTES,
          "explicit Groq selection takes precedence over endpoint classification"
        );
      }
    });
  }
});
