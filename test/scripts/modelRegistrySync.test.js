const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const models = path.join(__dirname, "../../src/models");
const VENDORED = [
  "modelRegistryData.json",
  "registryMetadata.json",
  "registrySchema.cjs",
  "registryEnvelope.cjs",
  "registrySelection.js",
  "registryBundle.json",
];

// A copy beside the repo's node_modules, so the vendored reader's `zod` import resolves.
function vendoredCopy(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, "../../node_modules/.cache-sync-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of VENDORED) {
    // registryBundle.json exists only once the app pins a signed publication.
    if (fs.existsSync(path.join(models, name)))
      fs.copyFileSync(path.join(models, name), path.join(dir, name));
  }
  return dir;
}

test("verify passes on the synced files and names the source", async (t) => {
  const { check } = await import("../../scripts/sync-model-registry.mjs");
  assert.match(await check(vendoredCopy(t)), /source [a-f0-9]{40}|publication \d+/);
});

test("verify rejects a hand-edited catalog or reader with the way to add models", async (t) => {
  const { check } = await import("../../scripts/sync-model-registry.mjs");
  for (const [file, edit] of [
    ["modelRegistryData.json", (text) => text.replace('"GPT-6 Luna"', '"GPT-6 Luna!"')],
    ["registrySelection.js", (text) => `${text}\n// local tweak\n`],
  ]) {
    const dir = vendoredCopy(t);
    const target = path.join(dir, file);
    fs.writeFileSync(target, edit(fs.readFileSync(target, "utf8")));
    await assert.rejects(check(dir), /OpenWhispr\/model-registry/, file);
  }
});

test("a release needs a published catalog the registry keeps serving", async () => {
  const { releaseProblems } = await import("../../scripts/sync-model-registry.mjs");
  const metadata = { publicationCommit: "a".repeat(40), manifestVersion: 4, clientContract: "c" };
  const good = { metadata, liveVersion: 4, liveTested: true, compatListed: true };
  assert.deepEqual(releaseProblems(good), []);
  assert.deepEqual(releaseProblems({ ...good, liveVersion: 9 }), [], "a newer live one is fine");
  for (const [broken, pattern] of [
    [{ metadata: { ...metadata, publicationCommit: undefined } }, /unpublished/],
    [{ liveVersion: 3 }, /ahead of live/],
    [{ liveTested: false }, /not tested/],
    [{ compatListed: false }, /compat\/clients/],
  ])
    assert.match(releaseProblems({ ...good, ...broken }).join(), pattern);
});
