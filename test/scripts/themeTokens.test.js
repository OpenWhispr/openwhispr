const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  SOURCE,
  OUTPUT,
  buildThemeCss,
  shortNames,
} = require("../../scripts/generate-theme-tokens");
const { renameColorTokens } = require("../../scripts/rename-color-tokens");

const root = path.join(__dirname, "..", "..");
const { tokens, source } = JSON.parse(fs.readFileSync(SOURCE, "utf8"));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory())
      return ["locales", "assets"].includes(entry.name) ? [] : sourceFiles(file);
    return /\.(tsx?|jsx?|css)$/.test(entry.name) ? [file] : [];
  });
}

test("theme-tokens.css is what the generator writes from colors.json", () => {
  assert.equal(
    fs.readFileSync(OUTPUT, "utf8"),
    buildThemeCss({ tokens, source }),
    "Run `node scripts/generate-theme-tokens.js` instead of editing theme-tokens.css"
  );
});

test("every Figma variable has a Light and a Dark value", () => {
  for (const [name, token] of Object.entries(tokens)) {
    assert.ok(token.light && token.dark, `${name} is missing a mode`);
  }
});

test("no source file uses a color name from before the Figma names", () => {
  // text-primary, text-secondary and text-accent exist under both schemes.
  const sharedNames = new Set(
    Object.keys(tokens).flatMap((name) =>
      shortNames(name)
        .filter((short) => short.startsWith("--text-color-"))
        .map((short) => `text-${short.slice("--text-color-".length)}`)
    )
  );

  const offenders = [];
  for (const file of sourceFiles(path.join(root, "src"))) {
    const counts = new Map();
    renameColorTokens(fs.readFileSync(file, "utf8"), counts);
    for (const rename of counts.keys()) {
      const [from, to] = rename.split(" -> ");
      if (from !== to && !sharedNames.has(from)) {
        offenders.push(`${path.relative(root, file)}: ${from} is now ${to}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("raw Tailwind palette colors stay out of components", () => {
  // Colors with no Figma variable yet: medal and speaker hues, the share card's
  // artwork, and a warning shared with onboarding, which keeps its own palette.
  const literalColorFiles = new Set(
    [
      "LeaderboardPodium.tsx",
      "LeaderboardSection.tsx",
      "LeaderboardShareDialog.tsx",
      "notes/MeetingTranscriptChat.tsx",
      "ui/ProviderCheckField.tsx",
    ].map((file) => path.join("src", "components", file))
  );
  const hues =
    "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
  const paletteClass = new RegExp(`(?<![\\w-])[a-z-]+-(?:${hues})-\\d{2,3}(?![\\w-])`, "g");

  const offenders = sourceFiles(path.join(root, "src"))
    .filter((file) => !literalColorFiles.has(path.relative(root, file)))
    .flatMap((file) =>
      (fs.readFileSync(file, "utf8").match(paletteClass) ?? []).map(
        (name) => `${path.relative(root, file)}: ${name}`
      )
    );
  assert.deepEqual(offenders, [], "Use a Figma color token (see src/styles/theme-tokens.css)");
});
