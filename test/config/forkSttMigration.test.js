const test = require("node:test");
const assert = require("node:assert/strict");

const NEW_BASE = "https://stt.titaniumlabs.us/v1";
const OLD = "x1gsjcjrmssitgnh7hthg7nd.coolify.titaniumlabs.us";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => Object.fromEntries(map),
  };
}

test("repoints legacy host, keeping path, trailing slash and endpoint suffix", async () => {
  const { migrateLegacySttUrl } = await import("../../src/config/forkSttMigration.ts");
  assert.equal(migrateLegacySttUrl(`https://${OLD}/v1`, "stt.titaniumlabs.us"), NEW_BASE);
  assert.equal(migrateLegacySttUrl(`https://${OLD}/v1/`, "stt.titaniumlabs.us"), `${NEW_BASE}/`);
  assert.equal(migrateLegacySttUrl(`https://${OLD}`, "stt.titaniumlabs.us"), "https://stt.titaniumlabs.us");
  assert.equal(
    migrateLegacySttUrl(`https://${OLD.toUpperCase()}/v1/audio/transcriptions`, "stt.titaniumlabs.us"),
    "https://stt.titaniumlabs.us/v1/audio/transcriptions"
  );
});

test("leaves other URLs and junk alone", async () => {
  const { migrateLegacySttUrl } = await import("../../src/config/forkSttMigration.ts");
  assert.equal(migrateLegacySttUrl("https://api.openai.com/v1", "stt.titaniumlabs.us"), null);
  assert.equal(migrateLegacySttUrl(`https://${OLD}.evil.example/v1`, "stt.titaniumlabs.us"), null);
  assert.equal(migrateLegacySttUrl("", "stt.titaniumlabs.us"), null);
  assert.equal(migrateLegacySttUrl("not a url", "stt.titaniumlabs.us"), null);
  assert.equal(migrateLegacySttUrl(null, "stt.titaniumlabs.us"), null);
});

test("migrateSavedSttUrls rewrites only legacy keys and is idempotent", async () => {
  const { migrateSavedSttUrls } = await import("../../src/config/forkSttMigration.ts");
  const storage = memoryStorage({
    cloudTranscriptionBaseUrl: `https://${OLD}/v1`,
    uploadCloudTranscriptionBaseUrl: `https://${OLD}/v1`,
    meetingCloudTranscriptionBaseUrl: "https://api.openai.com/v1",
  });
  assert.deepEqual(migrateSavedSttUrls(storage, NEW_BASE), [
    "cloudTranscriptionBaseUrl",
    "uploadCloudTranscriptionBaseUrl",
  ]);
  const after = storage.dump();
  assert.equal(after.cloudTranscriptionBaseUrl, NEW_BASE);
  assert.equal(after.meetingCloudTranscriptionBaseUrl, "https://api.openai.com/v1");
  assert.deepEqual(migrateSavedSttUrls(storage, NEW_BASE), []);
});

test("no-op when the default is itself the legacy host or invalid", async () => {
  const { migrateSavedSttUrls } = await import("../../src/config/forkSttMigration.ts");
  const storage = memoryStorage({ cloudTranscriptionBaseUrl: `https://${OLD}/v1` });
  assert.deepEqual(migrateSavedSttUrls(storage, `https://${OLD}/v1`), []);
  assert.deepEqual(migrateSavedSttUrls(storage, ""), []);
});
