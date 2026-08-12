const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return { app: { isReady: () => false, getPath: () => "", getAppPath: () => process.cwd() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { validateEnterpriseEndpoint } = require("../../src/helpers/enterpriseProviderErrors");

const rejects = (endpoint) => {
  assert.throws(
    () => validateEnterpriseEndpoint(endpoint),
    /Private\/metadata endpoints are not allowed\./,
    `expected ${endpoint} to be rejected`
  );
};

const accepts = (endpoint) => {
  assert.doesNotThrow(() => validateEnterpriseEndpoint(endpoint), `expected ${endpoint} to pass`);
};

test("IPv6 loopback and unique-local literals are rejected", () => {
  rejects("https://[::1]/openai");
  rejects("https://[fd00::1]/openai");
  rejects("https://[fc00::1]/openai");
  rejects("https://[fe80::1]/openai");
});

test("IPv4-mapped IPv6 literals are rejected after URL normalization", () => {
  // WHATWG URL rewrites [::ffff:169.254.169.254] to [::ffff:a9fe:a9fe].
  rejects("https://[::ffff:169.254.169.254]/openai");
  rejects("https://[::ffff:127.0.0.1]/openai");
  rejects("https://[::ffff:10.0.0.1]/openai");
});

test("public IPv6 endpoints are still accepted", () => {
  accepts("https://[2606:4700:4700::1111]/openai");
  accepts("https://[::ffff:8.8.8.8]/openai");
});

test("existing IPv4, metadata and suffix rules still hold", () => {
  rejects("https://169.254.169.254/openai");
  rejects("https://127.0.0.1/openai");
  rejects("https://10.0.0.1/openai");
  rejects("https://192.168.1.1/openai");
  rejects("https://172.16.0.1/openai");
  rejects("https://localhost/openai");
  rejects("https://metadata.google.internal/openai");
  rejects("https://foo.internal/openai");
  // WHATWG URL expands the decimal form to 127.0.0.1.
  rejects("https://2130706433/openai");
});

test("public https endpoints and empty input are accepted", () => {
  accepts("https://myresource.openai.azure.com/");
  accepts("https://8.8.8.8/openai");
  accepts("");
  accepts(undefined);
});

test("non-https endpoints are rejected", () => {
  assert.throws(
    () => validateEnterpriseEndpoint("http://myresource.openai.azure.com/"),
    /Endpoint must use HTTPS\./
  );
});
