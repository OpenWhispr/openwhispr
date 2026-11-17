const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listClients, checkCompatibility } = require("../lib/compat.cjs");
const { readCatalog } = require("../lib/catalog.cjs");
const seed = require("./seed.json");

const base = readCatalog();
const openai = (data) => data.cloudProviders.find((p) => p.id === "openai");

// An "older" reader: today's code, minus support for budget-style thinking floors.
function olderReader(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-client-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lib = path.join(__dirname, "..", "lib");
  for (const file of ["envelope.cjs", "registrySelection.js"])
    fs.copyFileSync(path.join(lib, file), path.join(dir, file));
  const schema = fs
    .readFileSync(path.join(lib, "schema.cjs"), "utf8")
    .replace(
      "const thinkingBudgetShape = { budget: z.number().int().min(0).max(1000000) };",
      "const thinkingBudgetShape = { budget: z.never() };"
    )
    .replace('require("./registrySelection.js")', `require(${JSON.stringify(path.join(dir, "registrySelection.js"))})`)
    .replace('require("zod")', `require(${JSON.stringify(require.resolve("zod"))})`);
  fs.writeFileSync(path.join(dir, "schema.cjs"), schema);
  return { id: "older", dir, appVersion: "1.12.0", floor: seed };
}

test("this repository's own reader accepts today's catalog", () => {
  const [own] = listClients();
  assert.equal(own.own, true);
  assert.deepEqual(checkCompatibility(base, [own]), [own.id]);
});

test("a field an older reader cannot parse needs a minAppVersion that excludes it", (t) => {
  const older = olderReader(t);
  const next = structuredClone(base);
  openai(next).models.push({
    id: "needs-new-reader",
    name: "New",
    description: "Fixture",
    thinkingFloor: { budget: 0 },
  });
  assert.throws(() => checkCompatibility(next, [older]), /cannot read cloudProviders\/openai\/needs-new-reader/);
  openai(next).models.at(-1).minAppVersion = "1.13.0";
  assert.doesNotThrow(() => checkCompatibility(next, [older]));
});

test("a catalog that loses a model an older app bundles fails", (t) => {
  // Simulate a reader that, unlike today's, does not restore bundled entries.
  const older = olderReader(t);
  const file = path.join(older.dir, "schema.cjs");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace("for (const model of shipped.models)", "for (const model of [])")
  );
  older.floor = structuredClone(seed);
  openai(older.floor).models.push({ id: "only-in-old-app", name: "Old", description: "Fixture" });
  assert.throws(() => checkCompatibility(base, [older]), /loses bundled model cloudProviders\/openai\/only-in-old-app/);
});

test("vendored readers must match the contract ID they are filed under", () => {
  const root = path.join(__dirname, "..", "compat", "clients");
  const bogus = path.join(root, "0".repeat(64));
  fs.mkdirSync(bogus, { recursive: true });
  try {
    for (const file of ["schema.cjs", "envelope.cjs", "registrySelection.js"])
      fs.copyFileSync(path.join(__dirname, "..", "lib", file), path.join(bogus, file));
    fs.writeFileSync(path.join(bogus, "client.json"), JSON.stringify({ appVersion: "1.0.0" }));
    fs.writeFileSync(path.join(bogus, "floor.json"), JSON.stringify(seed));
    assert.throws(() => listClients(), /does not match its files/);
  } finally {
    fs.rmSync(bogus, { recursive: true });
    if (!fs.readdirSync(root).length) fs.rmSync(path.join(__dirname, "..", "compat"), { recursive: true });
  }
});
