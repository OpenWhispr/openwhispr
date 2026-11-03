const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const { signEnvelope, MAX_ENVELOPE_BYTES } = require("../../src/models/registryEnvelope.cjs");
const { createRegistryLoader, MAX_VERSION_STEP } = require("../../src/helpers/registryLoader");
const seed = require("../../src/models/modelRegistryData.json");

const pair = generateKeyPairSync("ed25519");
const trustedKeys = { fixture: pair.publicKey.export({ type: "spki", format: "pem" }) };
const CLIENT = "c".repeat(64);
const openaiIds = (data) => data.cloudProviders.find((p) => p.id === "openai").models.map((m) => m.id);

function signed(version, data = seed, { tested = [CLIENT], extra = {} } = {}) {
  return JSON.stringify(
    signEnvelope(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          manifestVersion: version,
          publishedAt: "2026-11-03T12:00:00Z",
          sourceCommit: "a".repeat(40),
          contractHashes: { schema: "a".repeat(64), envelope: "b".repeat(64), selection: "c".repeat(64) },
          testedClientContracts: tested,
          data,
          ...extra,
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
  const requests = [];
  const config = {
    cachePath: path.join(dir, "registry.json"),
    bundledSnapshot: { data: seed, manifestVersion: 1 },
    clientContract: CLIENT,
    trustedKeys,
    appVersion: "1.12.0",
    applySnapshot: (snapshot) => applied.push(snapshot),
    onError: (error) => errors.push(error),
    isEnabled: () => true,
    startupDelayMs: 60000,
    fetch: async (url, init) => {
      requests.push(init);
      return new Response(signed(2));
    },
    ...options,
  };
  const loader = createRegistryLoader(config);
  t.after(() => loader.stop());
  return { loader, config, applied, errors, requests };
}

test("startup applies the bundle, then verified updates apply and persist with a backup", async (t) => {
  let version = 2;
  const x = setup(t, { fetch: async () => new Response(signed(version)) });
  await x.loader.start();
  assert.equal(x.applied[0].manifestVersion, 1);
  await x.loader.refresh();
  assert.equal(x.applied.at(-1).manifestVersion, 2);
  assert.equal(fs.readFileSync(x.config.cachePath, "utf8"), signed(2));
  version = 3;
  await x.loader.refresh();
  assert.equal(fs.readFileSync(x.config.cachePath, "utf8"), signed(3));
  assert.equal(fs.readFileSync(`${x.config.cachePath}.backup`, "utf8"), signed(2));
  version = 2;
  await x.loader.refresh();
  assert.equal(x.loader.getSnapshot().manifestVersion, 3, "older versions never overwrite");
});

test("a catalog with fields or entries this app cannot read still applies", async (t) => {
  const data = structuredClone(seed);
  const openai = data.cloudProviders.find((p) => p.id === "openai");
  openai.models[0].futureCapability = { mode: "turbo" };
  openai.models.push({ id: "future-reader-only", name: "F", description: "F", tokenParam: "x" });
  openai.models.push({ id: "plain-addition", name: "P", description: "P" });
  data.futureSection = {};
  const x = setup(t, {
    fetch: async () => new Response(signed(2, data, { extra: { futureEnvelopeField: true } })),
  });
  await x.loader.refresh();
  const accepted = x.loader.getSnapshot().data;
  assert.equal(x.loader.getSnapshot().manifestVersion, 2);
  assert.ok(openaiIds(accepted).includes("plain-addition"));
  assert.equal(openaiIds(accepted).includes("future-reader-only"), false);
  assert.equal(accepted.cloudProviders.find((p) => p.id === "openai").models[0].futureCapability, undefined);
  assert.equal(x.errors.length, 0);
});

test("a publication never removes a bundled model or redirects an endpoint", async (t) => {
  const data = structuredClone(seed);
  data.cloudProviders.find((p) => p.id === "openai").models = [];
  data.transcriptionProviders[0].baseUrl = "https://evil.example";
  const x = setup(t, { fetch: async () => new Response(signed(2, data)) });
  await x.loader.refresh();
  const accepted = x.loader.getSnapshot().data;
  assert.deepEqual(openaiIds(accepted), openaiIds(seed));
  assert.equal(accepted.transcriptionProviders[0].baseUrl, seed.transcriptionProviders[0].baseUrl);
});

test("untrusted, untested, implausible or malformed publications keep the usable catalog", async (t) => {
  let response;
  const x = setup(t, { fetch: async () => new Response(response) });
  for (const [bad, message] of [
    [signed(2).replace("Ed25519", "none"), /Untrusted/],
    [signed(2).replace('"fixture"', '"unknown-key"'), /Untrusted/],
    [signed(2, seed, { tested: ["d".repeat(64)] }), /not tested with this app/],
    [signed(2 + MAX_VERSION_STEP), /implausibly far ahead/],
    [signed(2, seed, { extra: { schemaVersion: 1 } }), /expected 2/],
    ["{", /JSON/],
  ]) {
    response = bad;
    x.errors.length = 0;
    await x.loader.refresh();
    assert.equal(x.loader.getSnapshot().manifestVersion, 1);
    assert.match(String(x.errors[0]?.message), message);
  }
  response = signed(1 + MAX_VERSION_STEP);
  await x.loader.refresh();
  assert.equal(x.loader.getSnapshot().manifestVersion, 1 + MAX_VERSION_STEP);
});

test("a damaged cache falls back to its backup, and with neither the app fetches at once", async (t) => {
  const backup = setup(t);
  fs.writeFileSync(backup.config.cachePath, "{");
  fs.writeFileSync(`${backup.config.cachePath}.backup`, signed(3));
  await backup.loader.start();
  assert.equal(backup.loader.getSnapshot().manifestVersion, 3);
  assert.equal(backup.requests.length, 0, "a restored cache waits for the normal startup delay");

  const fetched = new Promise((resolve) => {
    const missing = setup(t, {
      fetch: async () => {
        resolve();
        return new Response(signed(2));
      },
    });
    fs.writeFileSync(missing.config.cachePath, "{");
    void missing.loader.start();
  });
  await fetched;
});

test("an older cache never overrides a newer bundle", async (t) => {
  const x = setup(t, { bundledSnapshot: { data: seed, manifestVersion: 5 } });
  fs.writeFileSync(x.config.cachePath, signed(4));
  await x.loader.start();
  assert.equal(x.loader.getSnapshot().manifestVersion, 5);
});

test("unchanged catalogs are revalidated with an ETag and a 304 changes nothing", async (t) => {
  let status = 200;
  const x = setup(t, {
    fetch: async (_url, init) => {
      x.requests.push(init);
      return status === 304
        ? new Response(null, { status: 304 })
        : new Response(signed(2), { headers: { etag: '"v2"' } });
    },
  });
  await x.loader.refresh();
  status = 304;
  await x.loader.refresh();
  assert.equal(x.requests[0].headers["If-None-Match"], undefined);
  assert.equal(x.requests[1].headers["If-None-Match"], '"v2"');
  assert.equal(x.loader.getSnapshot().manifestVersion, 2);
  assert.equal(x.errors.length, 0);
});

test("turning updates off uses only the bundle: no cache and no network", async (t) => {
  let enabled = false;
  const x = setup(t, { isEnabled: () => enabled });
  fs.writeFileSync(x.config.cachePath, signed(3));
  await x.loader.start();
  await x.loader.refresh();
  assert.equal(x.loader.getSnapshot().manifestVersion, 1);
  assert.equal(x.requests.length, 0);
  enabled = true;
  await x.loader.refresh();
  assert.equal(x.loader.getSnapshot().manifestVersion, 2);
});

test("an invalid bundled catalog or malformed app version never throws", async (t) => {
  for (const options of [
    { bundledSnapshot: { data: { cloudProviders: "broken" }, manifestVersion: 1 } },
    { appVersion: "1.11" },
    { appVersion: undefined },
  ]) {
    const x = setup(t, options);
    await assert.doesNotReject(x.loader.start());
    await assert.doesNotReject(x.loader.refresh());
  }
});

test("streaming response limit is enforced without trusting Content-Length", async (t) => {
  const x = setup(t, {
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_ENVELOPE_BYTES + 1));
            controller.close();
          },
        })
      ),
  });
  await x.loader.refresh();
  assert.equal(x.loader.getSnapshot().manifestVersion, 1);
  assert.match(x.errors[0].message, /large/);
});

test("concurrent refreshes share one request and stop aborts pending work", async (t) => {
  let calls = 0;
  let release;
  const x = setup(t, {
    fetch: async () => {
      calls++;
      return await new Promise((resolve) => (release = resolve));
    },
  });
  const a = x.loader.refresh();
  const b = x.loader.refresh();
  assert.equal(calls, 1);
  x.loader.stop();
  release(new Response(signed(2)));
  await Promise.all([a, b]);
  assert.equal(x.loader.getSnapshot().manifestVersion, 1);
});

test("timeouts and failing reporters are recoverable", async (t) => {
  let slow = true;
  const x = setup(t, {
    timeoutMs: 5,
    onError: async () => {
      throw new Error("reporter unavailable");
    },
    fetch: async (_url, init) =>
      slow
        ? new Promise((_resolve, reject) =>
            init.signal.addEventListener("abort", () => reject(new Error("timeout")))
          )
        : new Response(signed(2)),
  });
  fs.mkdirSync(x.config.cachePath);
  await assert.doesNotReject(x.loader.start());
  await x.loader.refresh();
  assert.equal(x.loader.getSnapshot().manifestVersion, 1);
  slow = false;
  await x.loader.refresh();
  assert.equal(x.loader.getSnapshot().manifestVersion, 2);
});

test("a cache that exists but cannot be used marks the catalog pending until one loads", async (t) => {
  const x = setup(t);
  fs.writeFileSync(x.config.cachePath, "{");
  await x.loader.start();
  assert.equal(x.applied[0].pending, true);
  await x.loader.refresh();
  assert.equal(x.applied.at(-1).pending, false);
  const fresh = setup(t);
  await fresh.loader.start();
  assert.equal(fresh.applied[0].pending, false, "a fresh install has nothing pending");
});
