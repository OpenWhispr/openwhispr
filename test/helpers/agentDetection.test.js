const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/agentDetection.ts");

test("stripAgentAddress removes the leading cue and name, keeping the command", async () => {
  const { stripAgentAddress } = await load();
  assert.equal(stripAgentAddress("Hey OpenWhispr, make this formal", "OpenWhispr"), "make this formal");
  assert.equal(stripAgentAddress("Max take a note", "Max"), "take a note");
  assert.equal(
    stripAgentAddress("That's everything. OpenWhispr, format this", "OpenWhispr"),
    "That's everything. format this"
  );
  assert.equal(stripAgentAddress("make this formal", "OpenWhispr"), "make this formal");
  assert.equal(
    stripAgentAddress("OpenWhispr", "OpenWhispr"),
    "OpenWhispr",
    "never returns an empty command"
  );
});

test("matches the name when it starts the dictation", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("OpenWhispr, summarize this note", "OpenWhispr"), true);
  assert.equal(detectAgentName("Max take a note", "Max"), true);
});

test("matches the name after a greeting cue", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("hey OpenWhispr make this formal", "OpenWhispr"), true);
  assert.equal(detectAgentName("okay Max stop recording", "Max"), true);
});

test("matches the name opening a new sentence", async () => {
  const { detectAgentName } = await load();

  assert.equal(
    detectAgentName("That's everything. OpenWhispr, format this as bullets", "OpenWhispr"),
    true
  );
});

test("ignores mentions that are dictated content, not commands", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("I showed OpenWhispr to a friend yesterday", "OpenWhispr"), false);
  assert.equal(detectAgentName("we shipped the OpenWhispr update today", "OpenWhispr"), false);
  assert.equal(detectAgentName("the max value is ten", "Max"), false);
});

test("handles STT splitting or misspelling the name, with the same gating", async () => {
  const { detectAgentName } = await load();

  // Split across tokens ("Open Whisper") and misheard endings still match
  // when addressed...
  assert.equal(detectAgentName("hey open whisper translate this", "OpenWhispr"), true);
  assert.equal(detectAgentName("Open Whisper, take a note", "OpenWhispr"), true);
  // ...but not as a mid-sentence mention.
  assert.equal(
    detectAgentName("people keep calling open whisper a dictation app", "OpenWhispr"),
    false
  );
});

test("short names never fuzzy-match other words", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("Sam, what time is it", "Max"), false);
  assert.equal(detectAgentName("the maximum value is ten", "Max"), false);
});

test("rejects empty or single-character names", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("hey there", ""), false);
  assert.equal(detectAgentName("a quick note", "a"), false);
});

test("matches the Italian advertised wake phrase when dictating in Italian", async () => {
  const { detectAgentName } = await load();

  // The it locale advertises "Ehi {{agentName}}".
  assert.equal(detectAgentName("stavo pensando, Ehi Jarvis scrivi una mail", "Jarvis", "it"), true);
  assert.equal(detectAgentName("prendi nota di questo Ciao Jarvis riassumi", "Jarvis", "it"), true);
});

test("fails closed to English-only cues when the language is auto or unset", async () => {
  const { detectAgentName } = await load();

  // The caller resolves "auto" to the UI language before calling; an
  // unresolved language must not activate any localized cue.
  assert.equal(detectAgentName("dunque vediamo ehi Jarvis prendi nota", "Jarvis", "auto"), false);
  assert.equal(detectAgentName("dunque vediamo ehi Jarvis prendi nota", "Jarvis"), false);
  assert.equal(detectAgentName("dunque vediamo ehi Jarvis prendi nota", "Jarvis", "it"), true);
});

test("does not fire a foreign-language cue during English dictation", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("and then oye Jarvis said something", "Jarvis", "en"), false);
  assert.equal(detectAgentName("and then ehi Jarvis said something", "Jarvis", "en"), false);
  assert.equal(detectAgentName("bueno pues oye Jarvis apunta esto", "Jarvis", "es"), true);
});

test("keeps English cue behavior identical for every dictation language", async () => {
  const { detectAgentName } = await load();

  for (const language of [undefined, "auto", "en", "it", "ko"]) {
    assert.equal(
      detectAgentName("so anyway hey Jarvis make this formal", "Jarvis", language),
      true,
      `language=${language}`
    );
  }
});

test("ignores a localized cue word mid-sentence far from the name", async () => {
  const { detectAgentName } = await load();

  assert.equal(
    detectAgentName("gli ho detto ciao mentre parlavamo del progetto di Jarvis", "Jarvis", "it"),
    false
  );
  assert.equal(
    detectAgentName("dile hola a todos antes de mencionar a Jarvis", "Jarvis", "es"),
    false
  );
});

test("matches the Russian advertised wake phrase including its comma", async () => {
  const { detectAgentName } = await load();

  assert.equal(
    detectAgentName("так вот Привет, Джарвис напиши письмо о бюджете", "Джарвис", "ru"),
    true
  );
});

test("normalizes fullwidth punctuation so CJK cues and sentence ends work", async () => {
  const { detectAgentName } = await load();

  // No spaces around the fullwidth comma, the shape CJK STT actually emits.
  assert.equal(detectAgentName("えっと ねぇ Jarvis、メールを書いて", "Jarvis", "ja"), true);
  assert.equal(detectAgentName("以上です。 Jarvis、続けて", "Jarvis", "ja"), true);
  assert.equal(detectAgentName("うーん ねぇ、Jarvis、メールを書いて", "Jarvis", "ja"), true);
});

test("stripping a CJK address consumes its adjacent comma", async () => {
  const { stripAgentAddress } = await load();

  assert.equal(stripAgentAddress("ねぇ、Jarvis、メールを書いて", "Jarvis", "ja"), "メールを書いて");
  assert.equal(stripAgentAddress("嘿，Jarvis，总结这段话", "Jarvis", "zh-CN"), "总结这段话");
});

test("splits unsegmented CJK-Latin transitions so cue and name separate", async () => {
  const { detectAgentName } = await load();

  // Fully unsegmented shapes: cue glued to the name, name glued to the text.
  assert.equal(detectAgentName("えっと ねぇJarvis、メールを書いて", "Jarvis", "ja"), true);
  assert.equal(detectAgentName("嘿Jarvis帮我写邮件", "Jarvis", "zh"), true);
  assert.equal(detectAgentName("「ねぇJarvisを呼んで」", "Jarvis", "ja"), true);
});

test("matches configured Unicode names in unsegmented CJK transcripts", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("ねぇジャービス、メールを書いて", "ジャービス", "ja"), true);
  assert.equal(detectAgentName("你好小助手，帮我写邮件", "小助手", "zh-CN"), true);
  assert.equal(detectAgentName("ねぇélodieメールを書いて", "Élodie", "ja"), true);
});

test("does not treat an unsegmented CJK mention as an address", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("これは小助手についての話です", "小助手", "zh-CN"), false);
});

test("leaves CJK punctuation untouched outside ja and zh dictation", async () => {
  const { detectAgentName } = await load();

  // A quoted CJK brand must not create a sentence boundary in English.
  assert.equal(
    detectAgentName("we compared prices to 小米。Jarvis pull up the page", "Jarvis", "en"),
    false
  );
  assert.equal(
    detectAgentName("we compared prices to 小米。Jarvis pull up the page", "Jarvis", "zh"),
    true
  );
});

test("leaves non-CJK Unicode normalization behavior unchanged", async () => {
  const { detectAgentName } = await load();
  const decomposedName = "E\u0301lodie";

  assert.equal(detectAgentName(`${decomposedName} take a note`, decomposedName, "fr"), true);
});

test("maps regional language codes to their base cue set", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("我想了一下 嘿 Jarvis 帮我写邮件", "Jarvis", "zh-CN"), true);
  assert.equal(detectAgentName("我想了一下 嘿 Jarvis 幫我寫郵件", "Jarvis", "zh-TW"), true);
});

test("keeps detection English-only for languages without a localized cue set", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("well then ehi Jarvis take a note", "Jarvis", "ko"), false);
  assert.equal(detectAgentName("well then hey Jarvis take a note", "Jarvis", "ko"), true);
});

test("every locale's advertised wake phrase triggers detection in its language", async () => {
  const { detectAgentName } = await load();
  const fs = require("node:fs");
  const path = require("node:path");

  const localesDir = path.join(__dirname, "..", "..", "src", "locales");
  const locales = fs
    .readdirSync(localesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.equal(locales.length, 10);

  for (const locale of locales) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(localesDir, locale, "translation.json"), "utf8")
    );
    const advertised = translation.settingsPage.agentConfig.howItWorksDescription;
    // The advertised wake word is the last letter run before {{agentName}}.
    const match = advertised.match(/(\p{L}+)[^\p{L}]*\{\{agentName\}\}/u);
    assert.ok(match, `${locale}: no wake phrase before {{agentName}}`);
    const cue = match[1];
    assert.equal(
      detectAgentName(`one two ${cue} Jarvis three four`, "Jarvis", locale),
      true,
      `${locale}: advertised cue "${cue}" does not trigger`
    );
  }
});
