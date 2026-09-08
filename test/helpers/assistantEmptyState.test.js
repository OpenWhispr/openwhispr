const test = require("node:test");
const assert = require("node:assert/strict");
const i18next = require("i18next");
const { I18nextProvider } = require("react-i18next");
const { React, renderStatic } = require("./harness/reactSsr");

test("the empty Assistant offers three localized generic suggestions", async () => {
  await i18next.init({
    lng: "en",
    resources: {
      en: {
        translation: {
          assistant: {
            panel: {
              suggestions: {
                summarizeNotes: "Summarize my recent notes",
                calendar: "What is on my calendar?",
                draft: "Help me draft something",
              },
            },
          },
        },
      },
    },
  });

  const { AssistantEmptyState } =
    await import("../../src/components/dictation/AssistantEmptyState.tsx");
  const markup = renderStatic(
    I18nextProvider,
    { i18n: i18next },
    React.createElement(AssistantEmptyState, {
      disabled: true,
      onSelectSuggestion: () => {},
    })
  );

  assert.match(markup, /Summarize my recent notes/);
  assert.match(markup, /What is on my calendar\?/);
  assert.match(markup, /Help me draft something/);
  assert.equal((markup.match(/<button/g) ?? []).length, 3);
  assert.equal((markup.match(/ disabled=""/g) ?? []).length, 3);
});
