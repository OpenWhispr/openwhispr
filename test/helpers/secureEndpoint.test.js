const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/urlUtils.ts");

test("https endpoints are secure; plain http to a public host is not", async () => {
  const { isSecureHttpEndpoint } = await load();

  assert.equal(isSecureHttpEndpoint("https://api.openai.com/v1"), true);
  assert.equal(isSecureHttpEndpoint("http://api.openai.com/v1"), false);
});

test("loopback hosts are allowed over http", async () => {
  const { isSecureHttpEndpoint } = await load();

  assert.equal(isSecureHttpEndpoint("http://localhost:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://127.0.0.1:5000"), true);
  assert.equal(isSecureHttpEndpoint("http://127.0.1.1:3000"), true);
  assert.equal(isSecureHttpEndpoint("http://0.0.0.0:8000"), true);
  assert.equal(isSecureHttpEndpoint("http://[::1]:8080"), true);
});

test("public DNS names that resemble private IP prefixes still require https", async () => {
  const { isSecureHttpEndpoint } = await load();

  assert.equal(isSecureHttpEndpoint("http://127.example.com/v1"), false);
  assert.equal(isSecureHttpEndpoint("http://10.example.com/v1"), false);
  assert.equal(isSecureHttpEndpoint("http://192.168.example.com/v1"), false);
  assert.equal(isSecureHttpEndpoint("http://172.16.example.com/v1"), false);
  assert.equal(isSecureHttpEndpoint("http://100.64.example.com/v1"), false);
  assert.equal(isSecureHttpEndpoint("http://169.254.example.com/v1"), false);
  assert.equal(isSecureHttpEndpoint("http://127.0.0.1.nip.io/v1"), false);

  assert.equal(isSecureHttpEndpoint("https://127.example.com/v1"), true);
});

test("URL-parser abbreviations of loopback IPv4 remain allowed over http", async () => {
  const { isSecureHttpEndpoint } = await load();

  // WHATWG URL expands forms like 127.1 → 127.0.0.1 before our host check.
  assert.equal(isSecureHttpEndpoint("http://127.1/v1"), true);
  assert.equal(isSecureHttpEndpoint("http://127.0.1/v1"), true);
});

test("RFC 1918 private ranges are allowed over http — self-hosted LLM servers live there", async () => {
  const { isSecureHttpEndpoint } = await load();

  assert.equal(isSecureHttpEndpoint("http://10.0.0.5:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://192.168.1.100:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://172.16.0.1:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://172.31.255.255:8080"), true);
});

test("172.x outside the 16-31 private block is public and rejected over http", async () => {
  const { isSecureHttpEndpoint } = await load();

  assert.equal(isSecureHttpEndpoint("http://172.15.0.1:8080"), false);
  assert.equal(isSecureHttpEndpoint("http://172.32.0.1:8080"), false);
});

test("CGNAT 100.64.0.0/10 is treated as private (Tailscale addresses)", async () => {
  const { isSecureHttpEndpoint } = await load();

  assert.equal(isSecureHttpEndpoint("http://100.64.0.1:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://100.127.255.254:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://100.63.0.1:8080"), false);
  assert.equal(isSecureHttpEndpoint("http://100.128.0.1:8080"), false);
});

test("link-local, IPv6 ULA, and .local hostnames are allowed over http", async () => {
  const { isSecureHttpEndpoint } = await load();

  assert.equal(isSecureHttpEndpoint("http://169.254.1.1:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://[fe80::1]:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://[fe90::1]:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://[fea0::1]:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://[febf::1]:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://[fe7f::1]:8080"), false);
  assert.equal(isSecureHttpEndpoint("http://[fc00::1]:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://[fd12::1]:8080"), true);
  assert.equal(isSecureHttpEndpoint("http://myserver.local:8080"), true);
});

test("Tailscale MagicDNS hostnames (.ts.net) are allowed over http", async () => {
  const { isSecureHttpEndpoint } = await load();

  assert.equal(isSecureHttpEndpoint("http://myserver.tailnet-1234.ts.net:8080"), true);
  // Only true subdomains of ts.net qualify — look-alike public domains do not.
  assert.equal(isSecureHttpEndpoint("http://myts.net:8080"), false);
  assert.equal(isSecureHttpEndpoint("http://evil-ts.net:8080"), false);
  assert.equal(isSecureHttpEndpoint("http://ts.net:8080"), false);
});

test("unparseable input is never secure", async () => {
  const { isSecureHttpEndpoint } = await load();

  assert.equal(isSecureHttpEndpoint(""), false);
  assert.equal(isSecureHttpEndpoint("not-a-url"), false);
});

test("secure HTTP endpoints reject non-HTTP schemes even on private hosts", async () => {
  const { isSecureHttpEndpoint } = await load();

  assert.equal(isSecureHttpEndpoint("https://api.example.com/v1"), true);
  assert.equal(isSecureHttpEndpoint("http://192.168.1.20:5001/v1"), true);
  assert.equal(isSecureHttpEndpoint("http://public.example.com/v1"), false);
  assert.equal(isSecureHttpEndpoint("ftp://192.168.1.20/v1"), false);
  assert.equal(isSecureHttpEndpoint("ws://127.0.0.1:5001/v1"), false);
});
