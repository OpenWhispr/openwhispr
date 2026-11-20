const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveForkConfig } = require("../../src/config/forkConfig");
const fork = require("../../src/config/fork.config.json");

test("cloud disabled by default: no hosted URL in shipped config", () => {
  const cfg = resolveForkConfig({}, {});
  assert.equal(cfg.API_URL, "");
  assert.equal(cfg.AUTH_URL, "");
  assert.equal(cfg.CLOUD_ENABLED, false);
});

test("cloud needs both API and auth URLs", () => {
  assert.equal(
    resolveForkConfig({ VITE_OPENWHISPR_API_URL: "https://a.example" }, {}).CLOUD_ENABLED,
    false
  );
  assert.equal(resolveForkConfig({ VITE_AUTH_URL: "https://b.example" }, {}).CLOUD_ENABLED, false);
  const cfg = resolveForkConfig(
    { VITE_OPENWHISPR_API_URL: "https://a.example/", VITE_AUTH_URL: "https://b.example" },
    {}
  );
  assert.equal(cfg.CLOUD_ENABLED, true);
  assert.equal(cfg.API_URL, "https://a.example");
});

test("runtime-env.json can enable cloud", () => {
  const cfg = resolveForkConfig(
    {},
    { VITE_OPENWHISPR_API_URL: "https://a.example", VITE_AUTH_URL: "https://b.example" }
  );
  assert.equal(cfg.CLOUD_ENABLED, true);
});

test("shipped config contains no upstream hosts and has default STT", () => {
  assert.doesNotMatch(JSON.stringify(fork), /openwhispr\.com|gizmovoice/);
  assert.equal(fork.DEFAULT_STT.model, "parakeet-unified-en-0.6b");
  assert.match(fork.DEFAULT_STT.baseUrl, /\/v1$/);
});

test("loadRuntimeEnv reads runtime-env.json and feeds getApiUrl/getAuthUrl resolution", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { loadRuntimeEnv } = require("../../src/config/forkConfig");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-rt-"));
  const file = path.join(dir, "runtime-env.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      VITE_OPENWHISPR_API_URL: "https://a.example/",
      VITE_AUTH_URL: "https://b.example",
    })
  );
  const cfg = resolveForkConfig({}, loadRuntimeEnv(file));
  assert.equal(cfg.API_URL, "https://a.example");
  assert.equal(cfg.AUTH_URL, "https://b.example");
  assert.equal(cfg.CLOUD_ENABLED, true);
  assert.deepEqual(loadRuntimeEnv(path.join(dir, "missing.json")), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SERVICES_URL defaults to our stable services host and VITE_SERVICES_URL overrides it", () => {
  assert.equal(fork.SERVICES_URL, "https://stt.titaniumlabs.us");
  assert.equal(resolveForkConfig({}, {}).SERVICES_URL, "https://stt.titaniumlabs.us");
  assert.equal(
    resolveForkConfig({ VITE_SERVICES_URL: "https://svc.example" }, {}).SERVICES_URL,
    "https://svc.example"
  );
  assert.equal(
    resolveForkConfig({}, { VITE_SERVICES_URL: "https://rt.example" }).SERVICES_URL,
    "https://rt.example"
  );
});

test("SITE_URL stays the website base, separate from SERVICES_URL", () => {
  assert.equal(fork.SITE_URL, "");
  assert.notEqual(fork.SITE_URL, fork.SERVICES_URL);
});
