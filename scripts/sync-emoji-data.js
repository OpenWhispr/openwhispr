#!/usr/bin/env node
// Generates the emoji picker datasets in src/data/emoji/ from emojibase-data (a
// devDependency): one file per app locale it covers, keeping only what the picker
// needs — the emoji, its localized label and search tags, its group, and the Emoji
// version that introduced it (so the picker can hide glyphs the OS can't render).
// Group names come from the app's own translations (emojiPicker.groups), not from
// emojibase, whose CLDR messages are wrong in several locales.
// Re-run after bumping emojibase-data: node scripts/sync-emoji-data.js

const fs = require("fs");
const path = require("path");

// App locale → emojibase locale. Locales absent here (ar) fall back to en at runtime.
const LOCALES = {
  de: "de",
  en: "en",
  es: "es",
  fr: "fr",
  it: "it",
  ja: "ja",
  pt: "pt",
  ru: "ru",
  "zh-CN": "zh",
  "zh-TW": "zh-hant",
};
// Skin-tone and hair modifiers: not pickable on their own.
const COMPONENT_GROUP = 2;
const OUT_DIR = path.join(__dirname, "..", "src", "data", "emoji");

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const [appLocale, emojibaseLocale] of Object.entries(LOCALES)) {
  const data = require(`emojibase-data/${emojibaseLocale}/data.json`);

  const emoji = data
    .filter((entry) => entry.group != null && entry.group !== COMPONENT_GROUP)
    .sort((a, b) => a.order - b.order)
    .map(({ emoji, label, group, version, tags }) => ({
      emoji,
      label,
      group,
      version,
      ...(tags?.length ? { tags } : {}),
    }));

  const file = path.join(OUT_DIR, `${appLocale}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ emoji })}\n`);
  console.log(`${path.relative(process.cwd(), file)}: ${emoji.length} emoji`);
}
