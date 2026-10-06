#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "..", "src", "locales");
const BASE_LANG = "en";
const NAMESPACES = ["translation", "prompts"];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function flatten(obj, prefix = "") {
  const out = {};

  for (const [key, value] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value, next));
    } else {
      out[next] = value;
    }
  }

  return out;
}

function getPlaceholders(value) {
  if (typeof value !== "string") return [];
  const matches = value.match(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g) || [];
  return [...new Set(matches.map((match) => match.replace(/\{\{|\}\}/g, "").trim()))].sort();
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const PLURAL_SUFFIX = /^(.*)_(zero|one|two|few|many|other)$/;
// Counts a leaderboard, a member list or a streak can realistically carry.
// Spanish, French, Italian and Portuguese reserve "many" for millions, and no
// key here ever renders one, so requiring that form would fail every locale
// file over a case no user reaches.
const PROBE_LIMIT = 200;

// Which counts each of a locale's plural categories actually selects.
function pluralProbe(lang) {
  const rules = new Intl.PluralRules(lang);
  const selected = new Map();
  for (let count = 0; count <= PROBE_LIMIT; count++) {
    const category = rules.select(count);
    if (!selected.has(category)) selected.set(category, []);
    selected.get(category).push(count);
  }
  return selected;
}

/**
 * i18next resolves a plural form with the locale's own CLDR rules and then falls
 * back to English when that form is missing, so an absent form ships English
 * text rather than a grammar slip. And a category is not always "exactly one":
 * Russian's `one` also covers 21 and 31, French's covers 0, so a form for one of
 * those has to interpolate the count instead of writing the digit.
 */
function checkPlurals(lang, namespace, flat) {
  const selected = pluralProbe(lang);
  const forms = new Map();

  for (const key of Object.keys(flat)) {
    const match = key.match(PLURAL_SUFFIX);
    if (!match) continue;
    if (!forms.has(match[1])) forms.set(match[1], new Set());
    forms.get(match[1]).add(match[2]);
  }

  let missing = false;

  for (const [base, categories] of forms) {
    for (const [category, counts] of selected) {
      if (!categories.has(category)) {
        console.error(
          `[i18n] Missing plural form ${lang}/${namespace}: ${base}_${category} (${lang} uses it for ${counts.slice(0, 3).join(", ")})`
        );
        missing = true;
      }
    }

    for (const category of categories) {
      const counts = selected.get(category);
      if (!counts || counts.every((count) => count === 1)) continue;

      const value = flat[`${base}_${category}`];
      if (typeof value === "string" && !value.includes("{{count}}")) {
        console.error(
          `[i18n] Hardcoded count ${lang}/${namespace}: ${base}_${category} also renders for ${counts
            .filter((count) => count !== 1)
            .slice(0, 3)
            .join(", ")}, so it must interpolate {{count}}`
        );
        missing = true;
      }
    }
  }

  return missing;
}

const languages = fs
  .readdirSync(LOCALES_DIR)
  .filter((entry) => fs.statSync(path.join(LOCALES_DIR, entry)).isDirectory())
  .sort();

let failed = false;

for (const namespace of NAMESPACES) {
  const baseFile = path.join(LOCALES_DIR, BASE_LANG, `${namespace}.json`);

  if (!fs.existsSync(baseFile)) {
    console.error(`[i18n] Missing base file: ${baseFile}`);
    process.exit(1);
  }

  const baseFlat = flatten(readJson(baseFile));
  if (checkPlurals(BASE_LANG, namespace, baseFlat)) failed = true;

  for (const lang of languages) {
    if (lang === BASE_LANG) continue;

    const file = path.join(LOCALES_DIR, lang, `${namespace}.json`);
    if (!fs.existsSync(file)) {
      console.error(`[i18n] Missing file: ${file}`);
      failed = true;
      continue;
    }

    const flat = flatten(readJson(file));
    if (checkPlurals(lang, namespace, flat)) failed = true;

    for (const key of Object.keys(baseFlat)) {
      if (!(key in flat)) {
        console.error(`[i18n] Missing key ${lang}/${namespace}: ${key}`);
        failed = true;
        continue;
      }

      const basePlaceholders = getPlaceholders(baseFlat[key]);
      const langPlaceholders = getPlaceholders(flat[key]);
      if (!arraysEqual(basePlaceholders, langPlaceholders)) {
        console.error(
          `[i18n] Placeholder mismatch ${lang}/${namespace}: ${key} (expected ${basePlaceholders.join(", ")}, got ${langPlaceholders.join(", ")})`
        );
        failed = true;
      }
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log("[i18n] Locale keys and placeholders are consistent.");
