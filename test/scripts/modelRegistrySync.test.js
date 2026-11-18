const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const models = path.join(__dirname, "../../src/models");
const BUNDLED = [
  "modelRegistryData.json",
  "registryMetadata.json",
  "registrySchema.cjs",
  "registryEnvelope.cjs",
  "registrySelection.js",
  "registryTrustedKeys.json",
  "registryBundle.json",
];

// A copy beside the repo's node_modules, so the copied reader's `zod` import resolves.
function bundledCopy(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, "../../node_modules/.cache-sync-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of BUNDLED) {
    // registryBundle.json exists only in a release build, which pins a signed publication.
    if (fs.existsSync(path.join(models, name)))
      fs.copyFileSync(path.join(models, name), path.join(dir, name));
  }
  return dir;
}

test("the app bundles exactly what model-registry/ produces", async (t) => {
  const { check } = await import("../../scripts/sync-model-registry.mjs");
  assert.match(await check(bundledCopy(t)), /model-registry\/|publication \d+/);
});

test("verify rejects a hand-edited copy and says how to change models", async (t) => {
  const { check } = await import("../../scripts/sync-model-registry.mjs");
  for (const [file, edit] of [
    ["modelRegistryData.json", (text) => text.replace('"GPT-6 Luna"', '"GPT-6 Luna!"')],
    ["registrySelection.js", (text) => `${text}\n// local tweak\n`],
    ["registryTrustedKeys.json", (text) => text.replace("primary-2026-10", "primary-2026-11")],
    [
      "registryMetadata.json",
      (text) => text.replace(/"clientContract": "[a-f0-9]{4}/, '"clientContract": "0000'),
    ],
  ]) {
    const dir = bundledCopy(t);
    const target = path.join(dir, file);
    const before = fs.readFileSync(target, "utf8");
    fs.writeFileSync(target, edit(before));
    assert.notEqual(fs.readFileSync(target, "utf8"), before, file);
    await assert.rejects(check(dir), /npm run model-registry:sync/, file);
  }
});

test("outside a release the bundle claims no publication", async (t) => {
  const { check } = await import("../../scripts/sync-model-registry.mjs");
  const dir = bundledCopy(t);
  const file = path.join(dir, "registryMetadata.json");
  const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
  if (metadata.publicationCommit) return t.skip("release build: a publication is pinned");
  fs.writeFileSync(file, JSON.stringify({ ...metadata, manifestVersion: 7 }, null, 2) + "\n");
  await assert.rejects(check(dir), /version 0/);
});

test("a release bundles the newest publication of exactly its own catalog", async () => {
  const { choosePublication } = await import("../../scripts/sync-model-registry.mjs");
  const reader = { validateCatalog: (data) => data };
  const text = (data) => JSON.stringify(data, null, 2) + "\n";
  const metadata = { contractHashes: { schema: "s" } };
  const publication = (manifestVersion, data, schema = "s") => ({
    manifestVersion,
    data,
    contractHashes: { schema },
  });
  const mine = { models: ["a"] };
  const candidates = [
    publication(9, { models: ["a", "b"] }),
    publication(8, mine, "other reader"),
    publication(7, mine),
    publication(6, mine),
  ];
  const pick = (catalog) => choosePublication({ candidates, metadata, catalog, reader });
  assert.equal(pick(text(mine)).manifestVersion, 7);
  assert.equal(pick(text({ models: ["unpublished"] })), null);
});

test("a release needs a published catalog the registry keeps serving", async () => {
  const { releaseProblems } = await import("../../scripts/sync-model-registry.mjs");
  const manifest = { manifestVersion: 4, testedClientContracts: ["c"] };
  const good = { manifest, liveVersion: 4, liveTested: true, clientContract: "c" };
  assert.deepEqual(releaseProblems(good), []);
  assert.deepEqual(releaseProblems({ ...good, liveVersion: 9 }), [], "a newer live one is fine");
  for (const [broken, pattern] of [
    [{ manifest: null }, /not published.*Publish model registry.*later registry change/],
    [{ clientContract: "another reader" }, /publication of this catalog was not tested/],
    [{ liveTested: false }, /live publication was not tested/],
  ])
    assert.match(releaseProblems({ ...good, ...broken }).join(), pattern);
});

test("a reader the registry keeps no copy of fails verify, not the release", async (t) => {
  const { check } = await import("../../scripts/sync-model-registry.mjs");
  const registry = fs.mkdtempSync(path.join(__dirname, "../../node_modules/.cache-sync-registry-"));
  t.after(() => fs.rmSync(registry, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, "../../model-registry"), registry, {
    recursive: true,
    filter: (source) => !source.includes("node_modules"),
  });
  const dir = bundledCopy(t);
  await check(dir, registry);
  fs.rmSync(path.join(registry, "compat", "clients"), { recursive: true });
  await assert.rejects(check(dir, registry), /compat\/clients has no copy/);
});

test("--revision without a commit is an error, not the live tip", () => {
  const { spawnSync } = require("node:child_process");
  const script = path.join(__dirname, "../../scripts/sync-model-registry.mjs");
  for (const args of [["--revision"], ["--revision", ""], ["--revision", "main"]]) {
    const result = spawnSync(process.execPath, [script, "--pin-release", ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /--revision takes a commit/);
  }
});
