const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const registry = require("../../src/config/languageRegistry.json");

const PRESERVATION = "LANGUAGE PRESERVATION";

test("cleanup language defaults preserve mixed speech without overriding the user's prompt", async (t) => {
  installBrowserGlobals(t, { initialStorage: { _providerSettingsMigrated: "1" } });
  const vite = await createRendererServer(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const {
    resolvePrompt,
    getDefaultPromptText,
    wrapCleanupTranscript,
    appendPlainTextResponseSuffix,
  } = await vite.ssrLoadModule("/config/prompts/index.ts");
  const { getLanguageInstruction } = await vite.ssrLoadModule("/utils/languageSupport.ts");

  await t.test(
    "every selected language and auto preserve language spans, not a target language",
    () => {
      for (const language of [
        ...registry.languages.map((entry) => entry.code),
        undefined,
        "unknown",
      ]) {
        const instruction = getLanguageInstruction(language);
        assert.ok(instruction.startsWith(PRESERVATION), String(language));
        assert.match(instruction, /code-switches/);
        assert.match(instruction, /do not translate or transliterate/);
        assert.doesNotMatch(
          instruction,
          /entire output|consistent language|transcribed text will be/i
        );
      }
    }
  );

  await t.test("selected orthography applies only to matching spans", () => {
    for (const [language, expected] of [
      ["zh-CN", /For Chinese spans, use simplified/],
      ["zh-TW", /For Chinese spans, use traditional/],
      ["en-US", /For English corrections, use American/],
      ["en-GB", /For English corrections, use British/],
    ]) {
      assert.match(getLanguageInstruction(language), expected);
    }
    assert.doesNotMatch(getLanguageInstruction("fr"), /simplified|traditional|American|British/);
  });

  await t.test("default cleanup keeps current transcript-is-data protections and locale", () => {
    for (const uiLanguage of ["en", "zh-CN", "ar"]) {
      const prompt = resolvePrompt("cleanup", { agentName: "Max", language: "zh-CN", uiLanguage });
      assert.ok(prompt.startsWith(PRESERVATION));
      assert.ok(
        prompt.endsWith(
          getDefaultPromptText("cleanup", uiLanguage).replaceAll("{{agentName}}", "Max")
        )
      );
    }
    assert.equal(
      wrapCleanupTranscript("Good to see you，明天见"),
      "<transcript>\nGood to see you，明天见\n</transcript>\n\nOutput only the cleaned transcript."
    );
  });

  await t.test(
    "custom instructions explicitly outrank automatic defaults and keep substitutions",
    () => {
      const custom =
        "{{agentName}}: Keep English sentences and use traditional Chinese characters.";
      useSettingsStore.setState({ customPrompts: { cleanup: custom } });
      const prompt = resolvePrompt("cleanup", {
        agentName: "Max",
        language: "zh-CN",
        customDictionary: ["OpenWhispr"],
      });
      assert.match(prompt, /explicit.*instructions.*take precedence/i);
      assert.ok(prompt.indexOf("For Chinese spans") < prompt.indexOf("Max: Keep English"));
      assert.ok(prompt.indexOf("Max: Keep English") < prompt.lastIndexOf("Custom Dictionary"));
      assert.ok(prompt.endsWith("OpenWhispr"));
      assert.doesNotMatch(
        prompt,
        /THE SPEAKER IS NEVER/,
        "custom text replaces, not joins, the default template"
      );
    }
  );

  await t.test("translation uses its explicit target, never cleanup language preservation", () => {
    for (const custom of [undefined, "Translate into {{targetLanguage}} for {{agentName}}."]) {
      useSettingsStore.setState({ customPrompts: { translate: custom } });
      const prompt = resolvePrompt("translate", {
        agentName: "Max",
        language: "zh-CN",
        targetLanguageLabel: "French",
      });
      assert.match(prompt, /French/);
      assert.doesNotMatch(prompt, /LANGUAGE PRESERVATION|Chinese spans|do not translate/);
      assert.doesNotMatch(prompt, /\{\{targetLanguage\}\}/);
    }
  });

  await t.test(
    "agent prompts stay free of cleanup policy and retain the caret output suffix",
    () => {
      for (const kind of ["dictationAgent", "chatAgent"]) {
        useSettingsStore.setState({
          customPrompts: { [kind]: "Answer {{agentName}}'s question." },
        });
        const prompt = resolvePrompt(kind, { agentName: "Max", language: "zh-CN" });
        assert.equal(prompt, "Answer Max's question.");
        assert.ok(appendPlainTextResponseSuffix(prompt).startsWith(prompt + "\n\nOUTPUT FORMAT:"));
      }
    }
  );
});
