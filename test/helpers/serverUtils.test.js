const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");

const { isPortAvailable, findAvailablePort } = require("../../src/utils/serverUtils");

test("isPortAvailable returns true for a free port even when IPv6 is disabled", async () => {
  const available = await isPortAvailable(8178);
  assert.equal(available, true);
});

test("findAvailablePort returns the first free port in range", async () => {
  const port = await findAvailablePort(8178, 8199);
  assert.ok(port >= 8178 && port <= 8199, `Expected port in [8178,8199], got ${port}`);
});

test("isPortAvailable returns false when port is already bound", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(8197, "127.0.0.1", resolve));
  try {
    const available = await isPortAvailable(8197);
    assert.equal(available, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("findAvailablePort skips ports that are already in use", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(8178, "127.0.0.1", resolve));
  try {
    const port = await findAvailablePort(8178, 8199);
    assert.ok(port > 8178 && port <= 8199, `Expected port > 8178, got ${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("findAvailablePort throws when all ports are in use", async () => {
  // Bind three consecutive ports to exhaust a tiny range
  const servers = [];
  for (let p = 8195; p <= 8199; p++) {
    const s = net.createServer();
    await new Promise((resolve) => s.listen(p, "127.0.0.1", resolve));
    servers.push(s);
  }
  try {
    await assert.rejects(
      () => findAvailablePort(8195, 8199),
      /No available ports in range 8195-8199/
    );
  } finally {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  }
});
