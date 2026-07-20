const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/urlUtils.ts");

test("https endpoints are secure; plain http to a public host is not", async () => {
  const { isSecureEndpoint } = await load();

  assert.equal(isSecureEndpoint("https://api.openai.com/v1"), true);
  assert.equal(isSecureEndpoint("http://api.openai.com/v1"), false);
});

test("loopback hosts are allowed over http", async () => {
  const { isSecureEndpoint } = await load();

  assert.equal(isSecureEndpoint("http://localhost:8080"), true);
  assert.equal(isSecureEndpoint("http://127.0.0.1:5000"), true);
  assert.equal(isSecureEndpoint("http://127.0.1.1:3000"), true);
  assert.equal(isSecureEndpoint("http://0.0.0.0:8000"), true);
  assert.equal(isSecureEndpoint("http://[::1]:8080"), true);
});

test("RFC 1918 private ranges are allowed over http — self-hosted LLM servers live there", async () => {
  const { isSecureEndpoint } = await load();

  assert.equal(isSecureEndpoint("http://10.0.0.5:8080"), true);
  assert.equal(isSecureEndpoint("http://192.168.1.100:8080"), true);
  assert.equal(isSecureEndpoint("http://172.16.0.1:8080"), true);
  assert.equal(isSecureEndpoint("http://172.31.255.255:8080"), true);
});

test("172.x outside the 16-31 private block is public and rejected over http", async () => {
  const { isSecureEndpoint } = await load();

  assert.equal(isSecureEndpoint("http://172.15.0.1:8080"), false);
  assert.equal(isSecureEndpoint("http://172.32.0.1:8080"), false);
});

test("CGNAT 100.64.0.0/10 is treated as private (Tailscale addresses)", async () => {
  const { isSecureEndpoint } = await load();

  assert.equal(isSecureEndpoint("http://100.64.0.1:8080"), true);
  assert.equal(isSecureEndpoint("http://100.127.255.254:8080"), true);
  assert.equal(isSecureEndpoint("http://100.63.0.1:8080"), false);
  assert.equal(isSecureEndpoint("http://100.128.0.1:8080"), false);
});

test("link-local, IPv6 ULA, and .local hostnames are allowed over http", async () => {
  const { isSecureEndpoint } = await load();

  assert.equal(isSecureEndpoint("http://169.254.1.1:8080"), true);
  assert.equal(isSecureEndpoint("http://[fe80::1]:8080"), true);
  assert.equal(isSecureEndpoint("http://[fc00::1]:8080"), true);
  assert.equal(isSecureEndpoint("http://[fd12::1]:8080"), true);
  assert.equal(isSecureEndpoint("http://myserver.local:8080"), true);
});

test("unparseable input is never secure", async () => {
  const { isSecureEndpoint } = await load();

  assert.equal(isSecureEndpoint(""), false);
  assert.equal(isSecureEndpoint("not-a-url"), false);
});
