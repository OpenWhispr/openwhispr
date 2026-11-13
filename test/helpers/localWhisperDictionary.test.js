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

// ---- Meeting chunks -------------------------------------------------------
const {
  createMeetingPromptContext,
  buildMeetingChunkPrompt,
  transcribeMeetingChunkWithPrompt,
} = require("../../src/helpers/localWhisperDictionary");

const DE_DICT = ["Schellhas van Kisfeld", "Schellhas Consulting", "OpenWhispr"];

test("meeting prompt: dictionary first, previous chunk's tail last", async () => {
  const { prompt } = await buildMeetingChunkPrompt(DE_DICT, "wir sprachen über die Angebote.");
  assert.equal(prompt, `${DE_DICT.join(", ")} wir sprachen über die Angebote.`);
});

test("meeting prompt: context alone without a dictionary, null with neither", async () => {
  assert.equal((await buildMeetingChunkPrompt([], "hallo zusammen")).prompt, "hallo zusammen");
  assert.equal((await buildMeetingChunkPrompt([], "")).prompt, null);
});

test("meeting prompt: dictionary keeps priority and the prompt stays in budget", async () => {
  const many = Array.from({ length: 400 }, (_, i) => `Wort${i}`);
  const long = "wort ".repeat(100);
  const full = await buildMeetingChunkPrompt(many, long);
  const dictOnly = await buildMeetingChunkPrompt(many, "");
  assert.ok(full.prompt.length <= 900);
  assert.equal(full.prompt.startsWith(dictOnly.prompt), true);

  const small = await buildMeetingChunkPrompt(DE_DICT, long);
  assert.ok(small.prompt.startsWith(DE_DICT.join(", ")));
  assert.ok(small.contextTail.length <= 200);
  assert.ok(small.prompt.length <= 550);
});

test("meeting context: per source, word-boundary tail, reset clears", () => {
  const ctx = createMeetingPromptContext();
  ctx.remember("mic", "eins zwei drei");
  ctx.remember("system", `${"x".repeat(150)} anfang ${"y".repeat(10)} ende`);
  assert.equal(ctx.get("mic"), "eins zwei drei");
  assert.ok(ctx.get("system").length <= 200);
  assert.ok(!ctx.get("system").startsWith("xx") || ctx.get("system").length <= 200);
  ctx.remember("mic", "   ");
  assert.equal(ctx.get("mic"), "eins zwei drei");
  ctx.reset();
  assert.equal(ctx.get("mic"), "");
  assert.equal(ctx.get("system"), "");
});

test("meeting chunk: sends dictionary + context as initialPrompt", async () => {
  const m = fakeManager([{ success: true, text: "Das ist der nächste Satz." }]);
  const r = await transcribeMeetingChunkWithPrompt(
    m,
    "wav",
    { model: "turbo", language: "de", segments: true },
    DE_DICT,
    "vorheriger Satz."
  );
  assert.equal(r.text, "Das ist der nächste Satz.");
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].options.initialPrompt, `${DE_DICT.join(", ")} vorheriger Satz.`);
  assert.equal(m.calls[0].options.segments, true);
});

test("meeting chunk: no dictionary and no context sends no prompt", async () => {
  const m = fakeManager([{ success: true, text: "Hallo." }]);
  await transcribeMeetingChunkWithPrompt(m, "wav", { model: "turbo" }, [], "");
  assert.equal("initialPrompt" in m.calls[0].options, false);
});

test("meeting chunk: a recited dictionary is decoded again without the prompt", async () => {
  const m = fakeManager([
    { success: true, text: DE_DICT.join(", ") },
    { success: true, text: "Guten Tag." },
  ]);
  const r = await transcribeMeetingChunkWithPrompt(m, "wav", { model: "turbo" }, DE_DICT, "ctx");
  assert.equal(r.text, "Guten Tag.");
  assert.equal(m.calls.length, 2);
  assert.equal("initialPrompt" in m.calls[1].options, false);
});

test("meeting chunk: a recited fragment of the dictionary is retried", async () => {
  const m = fakeManager([
    { success: true, text: "Schellhas Consulting, " },
    { success: true, text: "" },
  ]);
  const r = await transcribeMeetingChunkWithPrompt(m, "wav", { model: "turbo" }, DE_DICT, "");
  assert.equal(r.text, "");
  assert.equal(m.calls.length, 2);
});

test("meeting chunk: a repeat of the context is retried without prompt", async () => {
  const m = fakeManager([
    { success: true, text: "wir sprachen über die Angebote" },
    { success: true, text: "Ja, genau." },
  ]);
  const r = await transcribeMeetingChunkWithPrompt(
    m,
    "wav",
    { model: "turbo" },
    [],
    "gestern wir sprachen über die Angebote."
  );
  assert.equal(r.text, "Ja, genau.");
  assert.equal(m.calls.length, 2);
});

test("meeting chunk: real speech containing a dictionary name is kept", async () => {
  const m = fakeManager([
    { success: true, text: "Ich arbeite bei Schellhas Consulting in Berlin." },
  ]);
  const r = await transcribeMeetingChunkWithPrompt(m, "wav", { model: "turbo" }, DE_DICT, "x y z");
  assert.equal(r.text, "Ich arbeite bei Schellhas Consulting in Berlin.");
  assert.equal(m.calls.length, 1);
});

test("meeting chunk: failures and empty results pass through untouched", async () => {
  const m = fakeManager([{ success: false, error: "boom" }]);
  const r = await transcribeMeetingChunkWithPrompt(m, "wav", {}, DE_DICT, "");
  assert.equal(r.success, false);
  assert.equal(m.calls.length, 1);
});
