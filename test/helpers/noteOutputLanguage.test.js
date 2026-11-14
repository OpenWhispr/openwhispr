const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/noteOutputLanguage.js");

test("language names come from the registry, with base UI codes and unknown codes handled", async () => {
  const { noteLanguageName } = await load();
  assert.equal(noteLanguageName("de"), "German");
  assert.equal(noteLanguageName("en"), "English");
  assert.equal(noteLanguageName("en-GB"), "English (UK)");
  assert.equal(noteLanguageName("zh-TW"), "Chinese (Traditional)");
  assert.equal(noteLanguageName("auto"), null);
  assert.equal(noteLanguageName("xx"), null);
  assert.equal(noteLanguageName(""), null);
  assert.equal(noteLanguageName(undefined), null);
});

test("a run's choice wins over the setting, and an unknown code is automatic", async () => {
  const { resolveNoteSummaryLanguage } = await load();
  assert.equal(resolveNoteSummaryLanguage("de", "fr"), "de");
  assert.equal(resolveNoteSummaryLanguage("auto", "fr"), "auto");
  assert.equal(resolveNoteSummaryLanguage(undefined, "fr"), "fr");
  assert.equal(resolveNoteSummaryLanguage("", "fr"), "fr");
  assert.equal(resolveNoteSummaryLanguage(undefined, undefined), "auto");
  assert.equal(resolveNoteSummaryLanguage("xx", "fr"), "auto");
  assert.equal(resolveNoteSummaryLanguage(undefined, "xx"), "auto");
});

test("automatic asks for the material's language and headings, with the interface language as fallback", async () => {
  const { noteOutputLanguageInstruction } = await load();
  const { NOTHING_TO_SUMMARIZE } = await import("../../src/helpers/builtinActions.js");
  const line = noteOutputLanguageInstruction("auto", "de");
  assert.match(line, /^OUTPUT LANGUAGE: Detect the language of the transcript/);
  assert.match(line, /write your entire output in that language, including the section headings/);
  assert.match(line, /headings above are English placeholders: translate every heading/);
  assert.match(line, /no clear language, write in German\./);
  assert.ok(line.endsWith(`Reply ${NOTHING_TO_SUMMARIZE} exactly as written, never translated.`));
  assert.match(noteOutputLanguageInstruction("auto", "zz"), /write in English\./);
  assert.match(noteOutputLanguageInstruction("auto", undefined), /write in English\./);
});

test("a chosen language is named outright and keeps the no-content marker untranslated", async () => {
  const { noteOutputLanguageInstruction } = await load();
  const line = noteOutputLanguageInstruction("de", "en");
  assert.match(
    line,
    /^OUTPUT LANGUAGE: Write your entire output in German, including the section headings/
  );
  assert.doesNotMatch(line, /Detect/);
  assert.doesNotMatch(line, /placeholders/);
  assert.match(line, /NOTHING_TO_SUMMARIZE exactly as written, never translated\.$/);
  // An unknown code falls back to the automatic line rather than naming nothing.
  assert.match(noteOutputLanguageInstruction("xx", "en"), /Detect the language/);
});

test("compiled prompts end with the language line only when one is given", async () => {
  const { compileTemplatePrompt, compileSummaryActionPrompt } =
    await import("../../src/helpers/templatePrompts.js");
  const { noteOutputLanguageInstruction } = await load();
  const outputLanguage = noteOutputLanguageInstruction("auto", "en");
  const template = { prompt: "Summarize." };
  const action = { prompt: "Shorten it." };
  assert.equal(
    compileTemplatePrompt(template, { outputLanguage }),
    `${compileTemplatePrompt(template)}\n\n${outputLanguage}`
  );
  for (const fromSummary of [true, false]) {
    assert.equal(
      compileSummaryActionPrompt(action, { fromSummary, outputLanguage }),
      `${compileSummaryActionPrompt(action, { fromSummary })}\n\n${outputLanguage}`
    );
  }
  assert.doesNotMatch(compileTemplatePrompt(template), /OUTPUT LANGUAGE/);
});

test("the template picker offers automatic, the UI languages and a setting outside them, named in the UI language", async () => {
  const { summaryLanguageChoices, summaryLanguageLabel } =
    await import("../../src/components/notes/summaryLanguageChoices.ts");
  const { SUPPORTED_UI_LANGUAGES } = await import("../../src/i18n.ts");
  assert.deepEqual(summaryLanguageChoices("auto"), ["auto", ...SUPPORTED_UI_LANGUAGES]);
  assert.deepEqual(summaryLanguageChoices("de"), ["auto", ...SUPPORTED_UI_LANGUAGES]);
  assert.deepEqual(summaryLanguageChoices("pl"), ["auto", ...SUPPORTED_UI_LANGUAGES, "pl"]);
  assert.deepEqual(summaryLanguageChoices("xx"), ["auto", ...SUPPORTED_UI_LANGUAGES]);
  assert.equal(summaryLanguageLabel("auto", "de", "Automatisch"), "Automatisch");
  assert.equal(summaryLanguageLabel("de", "de", "Automatisch"), "Deutsch");
  assert.equal(summaryLanguageLabel("fr", "fr", "Automatique"), "Français");
});
