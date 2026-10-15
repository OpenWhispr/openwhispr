const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const { signEnvelope, MAX_ENVELOPE_BYTES } = require("../../src/models/registryEnvelope.cjs");
const { createRegistryLoader } = require("../../src/helpers/registryLoader");
const seed = require("../../src/models/modelRegistryData.json");
const pair = generateKeyPairSync("ed25519");
const trustedKeys = { fixture: pair.publicKey.export({ type: "spki", format: "pem" }) };
function signed(version, data = seed) {
  return JSON.stringify(
    signEnvelope(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          contractHashes: {
            schema: "a".repeat(64),
            envelope: "b".repeat(64),
            selection: "c".repeat(64),
          },
          manifestVersion: version,
          publishedAt: "2026-10-14T12:00:00Z",
          sourceCommit: "a".repeat(40),
          data,
        })
      ),
      "fixture",
      pair.privateKey
    )
  );
}
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-loader-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const applied = [];
  const errors = [];
  let requests = 0;
  const config = {
    cachePath: path.join(dir, "registry.json"),
    bundledSnapshot: { data: seed, manifestVersion: 1 },
    trustedKeys,
    appVersion: "1.10.3",
    applySnapshot: (x) => applied.push(x),
    onError: (e) => errors.push(e),
    fetch: async () => {
      requests++;
      return new Response(signed(2));
    },
    ...options,
  };
  const loader = createRegistryLoader(config);
  t.after(() => loader.stop());
  return { loader, config, applied, errors, requests: () => requests };
}

test("verified updates persist, startup never waits for network, and older versions cannot overwrite them", async (t) => {
  const x = setup(t);
  await x.loader.start();
  assert.equal(x.requests(), 0);
  await x.loader.refresh();
  assert.equal(x.applied.at(-1).manifestVersion, 2);
  assert.equal(fs.readFileSync(x.config.cachePath, "utf8"), signed(2));
  await x.loader.refresh();
  assert.equal(x.applied.length, 1);
});
test("tampering, removed IDs, new endpoints, unknown schema and rollback retain the usable catalog", async (t) => {
  let response = signed(2);
  const x = setup(t, { fetch: async () => new Response(response) });
  await x.loader.refresh();
  const removed = structuredClone(seed);
  delete removed.whisperModels.base;
  const redirect = structuredClone(seed);
  redirect.transcriptionProviders[0].baseUrl = "https://evil.example";
  for (const bad of [
    signed(1),
    signed(3, removed),
    signed(3, redirect),
    signed(3).replace("Ed25519", "none"),
    "{",
  ]) {
    response = bad;
    await x.loader.refresh();
    assert.equal(x.loader.getSnapshot().manifestVersion, 2);
  }
  assert.equal(x.applied.length, 1);
});
test("a remotely added selected ID cannot disappear in a later signed publication", async (t) => {
  const next = structuredClone(seed);
  next.cloudProviders[0].models.push({
    id: "remote-selected",
    name: "Remote",
    description: "Fixture",
  });
  let response = signed(2, next);
  const x = setup(t, { fetch: async () => new Response(response) });
  await x.loader.refresh();
  response = signed(3);
  await x.loader.refresh();
  assert.equal(x.loader.getSnapshot().manifestVersion, 2);
  assert.equal(x.loader.getSnapshot().data.cloudProviders[0].models.at(-1).id, "remote-selected");
});
test("a newer verified offline cache is activated but an older cache never overrides the bundle", async (t) => {
  for (const version of [1, 2, 4]) {
    const x = setup(t, { bundledSnapshot: { data: seed, manifestVersion: 2 } });
    fs.writeFileSync(x.config.cachePath, signed(version));
    await x.loader.start();
    assert.equal(x.loader.getSnapshot().manifestVersion, Math.max(2, version));
    assert.equal(x.requests(), 0);
  }
});
test("partial, tampered and oversized cache files safely use the bundle", async (t) => {
  for (const bytes of [
    "{",
    signed(4).replace("Ed25519", "none"),
    " ".repeat(MAX_ENVELOPE_BYTES + 1),
  ]) {
    const x = setup(t);
    fs.writeFileSync(x.config.cachePath, bytes);
    await x.loader.start();
    assert.equal(x.loader.getSnapshot().manifestVersion, 1);
  }
});
test("streaming response limit is enforced without trusting Content-Length", async (t) => {
  const x = setup(t, {
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(MAX_ENVELOPE_BYTES + 1));
            c.close();
          },
        })
      ),
  });
  await x.loader.refresh();
  assert.equal(x.applied.length, 0);
  assert.match(x.errors[0].message, /large/);
});
test("concurrent refreshes share one request and stop aborts pending work", async (t) => {
  let calls = 0;
  let release;
  const x = setup(t, {
    fetch: async () => {
      calls++;
      return await new Promise((r) => (release = r));
    },
  });
  const a = x.loader.refresh();
  const b = x.loader.refresh();
  assert.equal(calls, 1);
  x.loader.stop();
  release(new Response(signed(2)));
  await Promise.all([a, b]);
  assert.equal(x.applied.length, 0);
});
test("timeout is recoverable and a later refresh succeeds", async (t) => {
  let slow = true;
  const x = setup(t, {
    timeoutMs: 5,
    fetch: async (_url, init) =>
      slow
        ? new Promise((_r, reject) =>
            init.signal.addEventListener("abort", () => reject(new Error("timeout")))
          )
        : new Response(signed(2)),
  });
  await x.loader.refresh();
  assert.equal(x.applied.length, 0);
  slow = false;
  await x.loader.refresh();
  assert.equal(x.applied.length, 1);
});
test("disk failure retains the valid live update and bundled mode activates no cache or network", async (t) => {
  const x = setup(t);
  fs.mkdirSync(x.config.cachePath);
  await x.loader.refresh();
  assert.equal(x.loader.getSnapshot().manifestVersion, 2);
  assert.equal(x.applied.length, 1);
  const off = setup(t, { mode: "bundled" });
  fs.writeFileSync(off.config.cachePath, signed(4));
  await off.loader.start();
  await off.loader.refresh();
  assert.equal(off.requests(), 0);
  assert.equal(off.applied.length, 0);
});

test("future entries in the bundle do not prevent later compatible publications", async (t) => {
  const data = structuredClone(seed);
  data.cloudProviders[0].models.push(
    { id: "future-a", name: "Future", description: "Fixture", minAppVersion: "2.0.0" },
    { id: "supported-b", name: "Supported", description: "Fixture", minAppVersion: "1.10.3" }
  );
  const next = structuredClone(data);
  next.cloudProviders[0].models.push({ id: "supported-c", name: "Newest", description: "Fixture" });
  const x = setup(t, {
    bundledSnapshot: { data, manifestVersion: 2 },
    fetch: async () => new Response(signed(3, next)),
  });
  assert.equal(
    x.loader.getSnapshot().data.cloudProviders[0].models.some((m) => m.id === "future-a"),
    false
  );
  await x.loader.refresh();
  assert.equal(x.loader.getSnapshot().manifestVersion, 3);
  assert.equal(x.loader.getSnapshot().data.cloudProviders[0].models.at(-1).id, "supported-c");
});
