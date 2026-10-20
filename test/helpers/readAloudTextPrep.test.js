const test = require("node:test");
const assert = require("node:assert/strict");
const {
  prepareTextForSpeech,
  splitSentences,
  MAX_READ_CHARACTERS,
  MAX_SENTENCE_CHARACTERS,
} = require("../../src/helpers/readAloud/textPrep");

test("splits on sentence punctuation and line breaks", () => {
  assert.deepEqual(splitSentences("Olá! Tudo bem? Sim.\nLinha nova."), [
    "Olá!",
    "Tudo bem?",
    "Sim.",
    "Linha nova.",
  ]);
});

test("does not split inside numbers or prices", () => {
  assert.deepEqual(splitSentences("Custa R$ 1.250,75 hoje. Fim."), [
    "Custa R$ 1.250,75 hoje.",
    "Fim.",
  ]);
});

test("breaks very long sentences at a comma", () => {
  const long = `${"palavra ".repeat(30)}, ${"outra ".repeat(60)}fim.`;
  const parts = splitSentences(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= MAX_SENTENCE_CHARACTERS));
  assert.equal(parts.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " ").trim());
});

test("returns no sentences for blank input", () => {
  assert.deepEqual(splitSentences("  "), []);
});

test("strips markdown emphasis, headings and list markers", () => {
  const input = "## Título\n- **Primeiro** item\n- _segundo_ item\n> citação";
  assert.equal(prepareTextForSpeech(input), "Título.\nPrimeiro item.\nsegundo item.\ncitação.");
});

test("keeps link labels and replaces bare URLs", () => {
  assert.equal(
    prepareTextForSpeech("Veja [a documentação](https://example.com/docs) ou https://x.dev/a"),
    "Veja a documentação ou link."
  );
});

test("drops fenced code blocks and emoji", () => {
  assert.equal(
    prepareTextForSpeech("Antes 🚀\n```js\nconst a = 1;\n```\nDepois!"),
    "Antes.\nDepois!"
  );
});

test("keeps existing punctuation and numbers untouched", () => {
  assert.equal(prepareTextForSpeech("Custa R$ 1.250,75 às 14h30."), "Custa R$ 1.250,75 às 14h30.");
});

test("returns empty string for blank or non-string input", () => {
  assert.equal(prepareTextForSpeech("   \n  "), "");
  assert.equal(prepareTextForSpeech(null), "");
});

test("caps very long selections", () => {
  const long = "a".repeat(MAX_READ_CHARACTERS + 50);
  assert.equal(prepareTextForSpeech(long).length, MAX_READ_CHARACTERS);
});
