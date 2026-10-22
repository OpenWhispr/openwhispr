const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { getCosmicActiveAppId } = require("../../src/helpers/cosmicToplevel");

function message(objectId, opcode, ...args) {
  const body = Buffer.concat(args);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(objectId, 0);
  header.writeUInt32LE((8 + body.length) * 0x10000 + opcode, 4);
  return Buffer.concat([header, body]);
}

function uint(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function bytes(buffer) {
  return Buffer.concat([uint(buffer.length), buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4)]);
}

const string = (value) => bytes(Buffer.from(`${value}\0`));
const states = (values) => bytes(Buffer.concat(values.map(uint)));

function readString(body, offset) {
  return body.toString("utf8", offset + 4, offset + 3 + body.readUInt32LE(offset));
}

// A compositor that lists `globals` and, once zcosmic_toplevel_info_v1 is bound, sends
// `toplevels` the way cosmic-comp does for a version 1 client. Records every bind.
function startCompositor(t, { globals, toplevels }) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-cosmic-"));
  const binds = [];
  const server = net.createServer((socket) => {
    let registry = null;
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8 && pending.length >= pending.readUInt32LE(4) >>> 16) {
        const size = pending.readUInt32LE(4) >>> 16;
        const objectId = pending.readUInt32LE(0);
        const opcode = pending.readUInt32LE(4) & 0xffff;
        const body = pending.subarray(8, size);
        pending = pending.subarray(size);

        if (objectId === 1 && opcode === 1) {
          registry = body.readUInt32LE(0);
          globals.forEach((name, index) =>
            socket.write(message(registry, 0, uint(index + 1), string(name), uint(3)))
          );
        } else if (objectId === 1 && opcode === 0) {
          socket.write(message(body.readUInt32LE(0), 0, uint(0)));
        } else if (objectId === registry && opcode === 0) {
          const interfaceName = readString(body, 4);
          const info = body.readUInt32LE(body.length - 4);
          binds.push({ interfaceName, version: body.readUInt32LE(body.length - 8) });
          toplevels.forEach((toplevel, index) => {
            const handle = 0xff000000 + index;
            socket.write(
              Buffer.concat([
                message(info, 0, uint(handle)),
                message(handle, 2, string(`${toplevel.appId} window`)),
                message(handle, 3, string(toplevel.appId)),
                message(handle, 8, states(toplevel.states)),
                message(handle, 1),
              ])
            );
          });
        }
      }
    });
  });
  const socketPath = path.join(runtimeDir, "wayland-test");
  t.after(() => {
    server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  return new Promise((resolve) =>
    server.listen(socketPath, () =>
      resolve({ env: { XDG_RUNTIME_DIR: runtimeDir, WAYLAND_DISPLAY: "wayland-test" }, binds })
    )
  );
}

test("returns the activated toplevel's app id from a version 1 bind", async (t) => {
  const { env, binds } = await startCompositor(t, {
    globals: ["wl_seat", "zcosmic_toplevel_info_v1"],
    toplevels: [
      { appId: "com.system76.CosmicEdit", states: [0] },
      { appId: "dev.warp.Warp", states: [0, 2] },
    ],
  });

  assert.equal(await getCosmicActiveAppId(env), "dev.warp.warp");
  assert.deepEqual(binds, [{ interfaceName: "zcosmic_toplevel_info_v1", version: 1 }]);
});

test("returns null when the compositor has no COSMIC toplevel info", async (t) => {
  const { env, binds } = await startCompositor(t, {
    globals: ["wl_seat"],
    toplevels: [{ appId: "dev.warp.Warp", states: [2] }],
  });

  assert.equal(await getCosmicActiveAppId(env), null);
  assert.deepEqual(binds, []);
});

test("returns null without a Wayland socket", async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-cosmic-"));
  try {
    assert.equal(
      await getCosmicActiveAppId({ XDG_RUNTIME_DIR: runtimeDir, WAYLAND_DISPLAY: "wayland-9" }),
      null
    );
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
