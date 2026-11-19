const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");

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

// A copy of model-registry/ beside node_modules, for the same reason.
function registryCopy(t) {
  const registry = fs.mkdtempSync(path.join(__dirname, "../../node_modules/.cache-sync-registry-"));
  t.after(() => fs.rmSync(registry, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, "../../model-registry"), registry, {
    recursive: true,
    filter: (source) => !source.includes("node_modules"),
  });
  return registry;
}

const json = (value) => JSON.stringify(value, null, 2) + "\n";
const PUBLISHED = "b".repeat(40);

// An unpinned bundle and its registry, both trusting a key made for the test, so the test
// can sign publications and a release can be pinned without the network. `serve` answers
// for the published branch at PUBLISHED with the given v2 files.
function release(t) {
  const registry = registryCopy(t);
  const dir = bundledCopy(t);
  const keys = generateKeyPairSync("ed25519");
  const trusted = { test: keys.publicKey.export({ type: "spki", format: "pem" }) };
  fs.writeFileSync(path.join(registry, "trusted-keys.json"), json(trusted));
  fs.writeFileSync(path.join(dir, "registryTrustedKeys.json"), json(trusted));
  fs.rmSync(path.join(dir, "registryBundle.json"), { force: true });
  const metadataFile = path.join(dir, "registryMetadata.json");
  const unpinned = {
    ...JSON.parse(fs.readFileSync(metadataFile, "utf8")),
    manifestVersion: 0,
    publicationCommit: null,
    sourceCommit: null,
  };
  fs.writeFileSync(metadataFile, json(unpinned));

  const { createPublication } = require(path.join(registry, "lib", "publication.cjs"));
  const { verifyEnvelope } = require(path.join(registry, "lib", "envelope.cjs"));
  const catalog = require(path.join(registry, "lib", "catalog.cjs")).readCatalog();
  const later = structuredClone(catalog);
  later.cloudProviders[0].models.push({ id: "added-later", name: "Later", description: "Fixture" });
  const publish = (data, previous, tested = [unpinned.clientContract]) => {
    const bytes =
      JSON.stringify(
        createPublication({
          data,
          previous: previous?.manifest,
          force: true,
          sourceCommit: "a".repeat(40),
          headCommit: "a".repeat(40),
          testedClientContracts: tested,
          keyId: "test",
          privateKey: keys.privateKey,
        })
      ) + "\n";
    return { bytes, manifest: verifyEnvelope(bytes, trusted) };
  };
  const requested = [];
  const serve = (files) => ({
    dir,
    from: registry,
    tip: () => PUBLISHED,
    fetchFile: async (url) => {
      const prefix = `https://raw.githubusercontent.com/OpenWhispr/openwhispr/${PUBLISHED}/v2/`;
      assert.ok(url.startsWith(prefix), url);
      const file = url.slice(prefix.length);
      requested.push(file);
      if (files[file] instanceof Error) throw files[file];
      if (!files[file]) throw Object.assign(new Error(`${url} answered HTTP 404`), { status: 404 });
      return files[file].bytes;
    },
  });
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
  const pinned = () => fs.existsSync(path.join(dir, "registryBundle.json"));
  return { dir, registry, catalog, later, publish, serve, requested, read, pinned, unpinned };
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
  const registry = registryCopy(t);
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

test("a release pins the signed publication of its catalog, live or earlier", async (t) => {
  const { pinRelease, check } = await import("../../scripts/sync-model-registry.mjs");

  const live = release(t);
  const only = live.publish(live.catalog);
  assert.match(
    await pinRelease(PUBLISHED, live.serve({ "manifest.json": only })),
    new RegExp(`Pinned signed publication 1 at ${PUBLISHED} \\(live is 1\\)`)
  );
  assert.deepEqual(JSON.parse(live.read("registryBundle.json")), JSON.parse(only.bytes));
  assert.deepEqual(JSON.parse(live.read("registryMetadata.json")), {
    ...live.unpinned,
    manifestVersion: 1,
    publicationCommit: PUBLISHED,
    sourceCommit: "a".repeat(40),
  });
  assert.equal(await check(live.dir, live.registry), "signed publication 1");

  // A later registry change is live: the release takes its own catalog's from the history,
  // at the tip of the published branch when no commit is named.
  const earlier = release(t);
  const mine = earlier.publish(earlier.catalog);
  const newest = earlier.publish(earlier.later, mine);
  const served = earlier.serve({ "manifest.json": newest, "history/1.json": mine });
  assert.match(await pinRelease(null, served), /Pinned signed publication 1 .*\(live is 2\)/);
  assert.deepEqual(earlier.requested, ["manifest.json", "history/1.json"]);
  assert.deepEqual(JSON.parse(earlier.read("registryBundle.json")), JSON.parse(mine.bytes));
});

test("a release whose catalog is not served pins nothing", async (t) => {
  const { pinRelease } = await import("../../scripts/sync-model-registry.mjs");
  const cases = [
    [
      "only another catalog is published",
      (r) => ({ "manifest.json": r.publish(r.later) }),
      /not published/,
    ],
    [
      "the history ends before this catalog",
      (r) => ({ "manifest.json": r.publish(r.later, r.publish(r.catalog)) }),
      /not published/,
    ],
    [
      "the history cannot be read",
      (r) => ({
        "manifest.json": r.publish(r.later, r.publish(r.catalog)),
        "history/1.json": new Error("history answered HTTP 500"),
      }),
      /HTTP 500/,
    ],
    [
      "the publication was not tested with this reader",
      (r) => ({ "manifest.json": r.publish(r.catalog, undefined, ["f".repeat(64)]) }),
      /not tested with this app's reader/,
    ],
  ];
  for (const [name, files, pattern] of cases) {
    const fixture = release(t);
    await assert.rejects(pinRelease(PUBLISHED, fixture.serve(files(fixture))), pattern, name);
    assert.equal(fixture.pinned(), false, name);
    assert.deepEqual(JSON.parse(fixture.read("registryMetadata.json")), fixture.unpinned, name);
  }
});

test("a pinned bundle must be the publication of the bundled catalog", async (t) => {
  const { pinRelease, check } = await import("../../scripts/sync-model-registry.mjs");
  const fixture = release(t);
  const mine = fixture.publish(fixture.catalog);
  await pinRelease(PUBLISHED, fixture.serve({ "manifest.json": mine }));
  const bundle = path.join(fixture.dir, "registryBundle.json");

  fs.writeFileSync(bundle, json(JSON.parse(fixture.publish(fixture.later, mine).bytes)));
  await assert.rejects(
    check(fixture.dir, fixture.registry),
    /does not match its signed publication/
  );
  fs.rmSync(bundle);
  await assert.rejects(check(fixture.dir, fixture.registry), /needs registryBundle\.json/);
});
