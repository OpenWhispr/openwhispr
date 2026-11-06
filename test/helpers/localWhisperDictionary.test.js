const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildLocalWhisperDictionaryPrompt,
  transcribeWithDictionary,
} = require("../../src/helpers/localWhisperDictionary");

const DICT = ["OpenWhispr", "Parakeet", "Alcahest", "Chromium", "TypeScript", "Electron"];

function fakeManager(outcomes) {
  const calls = [];
  return {
    calls,
    async transcribeLocalWhisper(audio, options) {
      calls.push({ audio, options });
      return outcomes[calls.length - 1] ?? outcomes.at(-1);
    },
  };
}

test("builds a comma-joined prompt, null for an empty dictionary", async () => {
  assert.equal(await buildLocalWhisperDictionaryPrompt(DICT), DICT.join(", "));
  assert.equal(await buildLocalWhisperDictionaryPrompt([]), null);
  assert.equal(await buildLocalWhisperDictionaryPrompt([" ", 3, null]), null);
});

test("caps the prompt to the decoder window", async () => {
  const many = Array.from({ length: 400 }, (_, i) => `Wort${i}`);
  const prompt = await buildLocalWhisperDictionaryPrompt(many);
  assert.ok(prompt.length <= 900);
});

test("passes the dictionary as initialPrompt and keeps other options", async () => {
  const m = fakeManager([{ success: true, text: "Das ist ein normaler Satz." }]);
  const r = await transcribeWithDictionary(m, "buf", { model: "turbo", language: "de" }, DICT);
  assert.equal(r.text, "Das ist ein normaler Satz.");
  assert.equal(m.calls.length, 1);
  assert.deepEqual(m.calls[0].options, {
    model: "turbo",
    language: "de",
    initialPrompt: DICT.join(", "),
  });
});

test("empty dictionary: no initialPrompt", async () => {
  const m = fakeManager([{ success: true, text: "Hallo" }]);
  await transcribeWithDictionary(m, "buf", { model: "turbo" }, []);
  assert.equal("initialPrompt" in m.calls[0].options, false);
});

test("an explicit initialPrompt is not overridden", async () => {
  const m = fakeManager([{ success: true, text: "Hallo" }]);
  await transcribeWithDictionary(m, "buf", { initialPrompt: "mine" }, DICT);
  assert.equal(m.calls[0].options.initialPrompt, "mine");
});

test("echo: retries without prompt", async () => {
  const m = fakeManager([
    { success: true, text: DICT.join(", ") },
    { success: true, text: "Guten Tag" },
  ]);
  const r = await transcribeWithDictionary(m, "buf", { model: "turbo" }, DICT);
  assert.equal(r.text, "Guten Tag");
  assert.equal(m.calls.length, 2);
  assert.equal("initialPrompt" in m.calls[1].options, false);
});

test("echo with onEcho=discard: empty text, no retry", async () => {
  const m = fakeManager([{ success: true, text: DICT.join(", ") }]);
  const r = await transcribeWithDictionary(m, "buf", {}, DICT, { onEcho: "discard" });
  assert.equal(r.success, true);
  assert.equal(r.text, "");
  assert.equal(m.calls.length, 1);
});

test("failure results pass through untouched", async () => {
  const fail = { success: false, error: "boom" };
  const m = fakeManager([fail]);
  assert.equal(await transcribeWithDictionary(m, "buf", {}, DICT), fail);
  assert.equal(m.calls.length, 1);
});
