const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

// #1908: the packaged app ships raw src/**/*.ts and loads part of it through
// Node's native ESM loader (type stripping) — no bundler in front. There a
// JSON import without `with { type: "json" }` throws ("needs an import
// attribute of \"type: json\"") and text cleanup dies in 1.9.x. Import each
// affected module exactly the way the packaged runtime does: a bare node
// child process, no tsx, no vite.
//
// ModelRegistry.ts carries the same fix but is not importable standalone
// (its importers use extensionless specifiers the ESM resolver rejects), so
// it has no probe here.
const MODULES = [
  "src/helpers/transcriptionRoute.ts", // the chain the issue's error came from
  "src/stores/policyRules.ts",
  "src/utils/languageSupport.ts",
  "src/locales/prompts.ts",
  "src/locales/translations.ts",
];

for (const rel of MODULES) {
  test(`native ESM loader imports ${rel} (JSON import attributes, #1908)`, () => {
    const abs = path.join(__dirname, "..", "..", rel);
    const script = `import(${JSON.stringify(abs)}).then(() => console.log("IMPORT_OK")).catch((e) => { console.error(e.message); process.exit(1); });`;
    let out;
    try {
      out = execFileSync(process.execPath, ["--no-warnings", "-e", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      assert.fail(`import failed: ${error.stderr || error.message}`);
    }
    assert.match(out, /IMPORT_OK/);
  });
}
