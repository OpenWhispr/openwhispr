#!/usr/bin/env node
// One-time codemod: renames the color utilities and CSS variables the app used
// before it took Figma's names (bg-card, text-muted-foreground,
// var(--color-primary)) to the names scripts/generate-theme-tokens.js writes.
//
// Run it once, on code that still uses only the old names. It is not
// idempotent: text-primary, text-secondary and text-accent exist under both
// schemes with different meanings (the brand blue, a grey surface and the accent
// purple before; body text, secondary text and accent/text after), so a second pass would rename the new names again. A
// branch cut before the rename therefore runs it BEFORE merging main, which
// then merges cleanly because main made the same edits:
//
//   git show main:scripts/rename-color-tokens.js > /tmp/rename-color-tokens.js
//   git show main:scripts/generate-theme-tokens.js > /tmp/generate-theme-tokens.js
//   node /tmp/rename-color-tokens.js src test
//
//   node scripts/rename-color-tokens.js <paths…>         rewrite files or folders
//   node scripts/rename-color-tokens.js --dry <paths…>   report only
const fs = require("fs");
const path = require("path");
const { cssName, shortNames } = require("./generate-theme-tokens");

// Old code token -> the Figma variable it took its value from.
const LEGACY_TOKENS = {
  background: "surface/primary",
  card: "surface/primary",
  popover: "surface/primary",
  input: "surface/primary",
  "surface-0": "surface/primary",
  "surface-2": "surface/primary",
  "surface-1": "surface/secondary",
  "surface-window": "surface/secondary",
  muted: "surface/secondary",
  secondary: "surface/secondary",
  "surface-3": "surface/tertiary",
  "surface-raised": "surface/tertiary",
  border: "border/default",
  "border-subtle": "border/default",
  "border-hover": "border/hover",
  "border-active": "border/focus",
  ring: "border/focus",
  foreground: "text/primary",
  "card-foreground": "text/primary",
  "popover-foreground": "text/primary",
  "secondary-foreground": "text/primary",
  "muted-foreground": "text/secondary",
  "foreground-tertiary": "text/tertiary",
  "state-hover": "state/hover",
  primary: "brand/solid",
  "primary-foreground": "text/on-solid",
  link: "brand/text",
  info: "brand/solid",
  "info-surface": "brand/surface",
  "info-border": "brand/border",
  "info-text": "brand/text",
  "info-foreground": "text/on-solid",
  success: "green/solid",
  "success-surface": "green/surface",
  "success-border": "green/border",
  "success-text": "green/text",
  "success-foreground": "text/on-solid",
  warning: "amber/solid",
  "warning-surface": "amber/surface",
  "warning-border": "amber/border",
  "warning-text": "amber/text",
  "warning-foreground": "text/on-solid",
  destructive: "red/solid",
  "destructive-surface": "red/surface",
  "destructive-border": "red/border",
  "destructive-text": "red/text",
  "destructive-foreground": "text/on-solid",
  accent: "accent/solid",
  "accent-text": "accent/text",
  "accent-foreground": "text/on-solid",
};

// Utility prefix -> the Tailwind namespace its short names live in.
const SIDES = ["x", "y", "t", "r", "b", "l", "s", "e"];
const UTILITY_NAMESPACES = {
  text: "--text-color-",
  border: "--border-color-",
  ...Object.fromEntries(SIDES.map((side) => [`border-${side}`, "--border-color-"])),
  divide: "--border-color-",
  ring: "--ring-color-",
  outline: "--outline-color-",
  bg: null,
  "ring-offset": null,
  fill: null,
  stroke: null,
  from: null,
  via: null,
  to: null,
  shadow: null,
  decoration: null,
  caret: null,
  accent: null,
  "inset-ring": null,
  "inset-shadow": null,
};

// Utilities that share a name with an old color token but are not colors.
const NOT_COLORS = new Set(["shadow-card"]);

const longestFirst = (a, b) => b.length - a.length;
const tokenPattern = Object.keys(LEGACY_TOKENS).sort(longestFirst).join("|");
const prefixPattern = Object.keys(UTILITY_NAMESPACES).sort(longestFirst).join("|");
const UTILITY = new RegExp(`(?<![\\w-])(${prefixPattern})-(${tokenPattern})(?![\\w-])`, "g");
const VARIABLE = new RegExp(`--color-(${tokenPattern})(?![\\w-])`, "g");

function renameUtility(prefix, token) {
  const figmaName = LEGACY_TOKENS[token];
  const namespace = UTILITY_NAMESPACES[prefix];
  const short = namespace && shortNames(figmaName).find((name) => name.startsWith(namespace));
  const value = short ? short.slice(namespace.length) : cssName(figmaName).slice("--color-".length);
  return `${prefix}-${value}`;
}

function renameColorTokens(source, counts = new Map()) {
  const count = (from, to) =>
    counts.set(`${from} -> ${to}`, (counts.get(`${from} -> ${to}`) || 0) + 1);
  return source
    .replace(UTILITY, (match, prefix, token) => {
      if (NOT_COLORS.has(match)) return match;
      const renamed = renameUtility(prefix, token);
      count(match, renamed);
      return renamed;
    })
    .replace(VARIABLE, (match, token) => {
      const renamed = cssName(LEGACY_TOKENS[token]);
      count(match, renamed);
      return renamed;
    });
}

const SOURCE_FILE = /\.(tsx?|jsx?|mjs|cjs|css|html)$/;
const SKIPPED_DIRS = new Set(["node_modules", "locales", "assets", "dist"]);
const SELF = new Set([__filename, path.join(__dirname, "generate-theme-tokens.js")]);

function* sourceFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (SOURCE_FILE.test(target) && !SELF.has(path.resolve(target))) yield target;
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
    yield* sourceFiles(path.join(target, entry.name));
  }
}

module.exports = { LEGACY_TOKENS, renameColorTokens };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const targets = args.filter((arg) => arg !== "--dry");
  if (!targets.length) {
    console.error(
      "Pass the files or folders to rename. Never run this on code that already uses the new names."
    );
    process.exit(1);
  }

  const counts = new Map();
  let changedFiles = 0;
  for (const target of targets) {
    for (const file of sourceFiles(target)) {
      const before = fs.readFileSync(file, "utf8");
      const after = renameColorTokens(before, counts);
      if (after === before) continue;
      changedFiles += 1;
      if (!dry) fs.writeFileSync(file, after);
    }
  }

  for (const [rename, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(String(n).padStart(5), rename);
  }
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  console.log(`${dry ? "Would rename" : "Renamed"} ${total} names in ${changedFiles} files`);
}
