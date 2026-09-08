const assert = require("node:assert/strict");
const test = require("node:test");

const {
  loadDistribution,
  loadSelectedDistribution,
  validateDistribution,
} = require("../../src/config/distributionSchema.ts");

test("loads the Oppulence Voice distribution with its owned update identity", () => {
  const distribution = loadDistribution("distributions/oppulence-voice.json", process.cwd());

  assert.equal(distribution.productName, "Oppulence Voice");
  assert.equal(distribution.appId, "engineering.oppulence.voice");
  assert.equal(distribution.protocolScheme, "oppulence-voice");
  assert.equal(distribution.windowsSafeCacheDirectory, "OppulenceVoice");
  assert.deepEqual(distribution.updates, {
    provider: "github",
    owner: "PlaybookMediaLLC",
    repo: "openwhispr",
    private: false,
  });
  assert.deepEqual(distribution.extensions, ["oppulence-cloud", "rowboat-export"]);
});

test("rejects unknown extensions and mismatched capability flags", () => {
  const base = loadDistribution("distributions/openwhispr.json", process.cwd());

  assert.throws(
    () => validateDistribution({ ...base, extensions: ["load-arbitrary-module"] }),
    /expected one of "rowboat-export"\|"oppulence-cloud"/
  );
  assert.throws(
    () =>
      validateDistribution({
        ...base,
        capabilities: { ...base.capabilities, rowboatExport: true },
      }),
    /enabled together/
  );
});

test("rejects malformed application and service identities", () => {
  const base = loadDistribution("distributions/openwhispr.json", process.cwd());

  assert.throws(() => validateDistribution({ ...base, appId: "not-an-app-id" }), /appId/);
  assert.throws(
    () => validateDistribution({ ...base, windowsSafeCacheDirectory: "unsafe cache" }),
    /windowsSafeCacheDirectory/
  );
  assert.throws(
    () =>
      validateDistribution({
        ...base,
        services: { ...base.services, apiUrl: "file:///tmp/api" },
      }),
    /apiUrl/
  );
  assert.throws(
    () =>
      validateDistribution({
        ...base,
        linux: { ...base.linux, dbusObjectPath: `/${"A/".repeat(10_000)}` },
      }),
    /dbusObjectPath/
  );
});

test("Oppulence Voice accepts only secure or loopback API overrides", () => {
  const local = loadSelectedDistribution({
    DISTRIBUTION_MANIFEST: "distributions/oppulence-voice.json",
    OPPULENCE_VOICE_API_URL: "http://127.0.0.1:18080/",
  });
  assert.equal(local.services.apiUrl, "http://127.0.0.1:18080");

  assert.throws(
    () =>
      loadSelectedDistribution({
        DISTRIBUTION_MANIFEST: "distributions/oppulence-voice.json",
        OPPULENCE_VOICE_API_URL: "http://api.example.com",
      }),
    /Expected HTTPS or a loopback HTTP URL/
  );
  assert.throws(
    () =>
      loadSelectedDistribution({
        DISTRIBUTION_MANIFEST: "distributions/openwhispr.json",
        OPPULENCE_VOICE_API_URL: "http://127.0.0.1:18080",
      }),
    /may only override/
  );
});
