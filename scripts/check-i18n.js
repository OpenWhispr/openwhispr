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

  for (const lang of languages) {
    if (lang === BASE_LANG) continue;

    const file = path.join(LOCALES_DIR, lang, `${namespace}.json`);
    if (!fs.existsSync(file)) {
      console.error(`[i18n] Missing file: ${file}`);
      failed = true;
      continue;
    }

    const flat = flatten(readJson(file));

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
