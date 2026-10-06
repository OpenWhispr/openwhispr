const net = require("net");
const path = require("path");

// The app id of the focused window on cosmic-comp, lowercased, or null. COSMIC has no
// command or D-Bus call for it and xdotool only sees X11 windows, so this speaks the
// Wayland wire protocol to zcosmic_toplevel_info_v1. Version 1 of that global sends
// every toplevel's app_id and state as soon as it is bound (version 2 moved app_id to
// ext_foreign_toplevel_list_v1), so two roundtrips answer the question.

const TOPLEVEL_INFO = "zcosmic_toplevel_info_v1";
const STATE_ACTIVATED = 2;
const TIMEOUT_MS = 300;

// Client object ids, allocated in the order the requests create them.
const DISPLAY = 1;
const REGISTRY = 2;
const GLOBALS_LISTED = 3;
const TOPLEVEL_INFO_ID = 4;
const TOPLEVELS_LISTED = 5;

// Wayland messages use host byte order, little-endian on every platform OpenWhispr ships.
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

function string(value) {
  const bytes = Buffer.from(`${value}\0`);
  return Buffer.concat([uint(bytes.length), bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
}

// A string or array argument: its byte length, then the bytes.
function readBytes(body, offset) {
  return body.subarray(offset + 4, offset + 4 + body.readUInt32LE(offset));
}

function readString(body, offset) {
  const bytes = readBytes(body, offset);
  return bytes.toString("utf8", 0, Math.max(bytes.length - 1, 0));
}

function getCosmicActiveAppId(env = process.env) {
  const display = env.WAYLAND_DISPLAY || "wayland-0";
  const socketPath = path.isAbsolute(display)
    ? display
    : path.join(env.XDG_RUNTIME_DIR || "", display);

  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const toplevels = new Map();
    let toplevelInfoName = null;
    let pending = Buffer.alloc(0);

    const finish = (appId) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(appId);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);

    const handleEvent = (objectId, opcode, body) => {
      if (objectId === REGISTRY && opcode === 0) {
        // wl_registry.global: name, interface, version
        if (readString(body, 4) === TOPLEVEL_INFO) toplevelInfoName = body.readUInt32LE(0);
      } else if (objectId === GLOBALS_LISTED && toplevelInfoName === null) {
        finish(null);
      } else if (objectId === GLOBALS_LISTED) {
        socket.write(
          Buffer.concat([
            // wl_registry.bind, then wl_display.sync
            message(
              REGISTRY,
              0,
              uint(toplevelInfoName),
              string(TOPLEVEL_INFO),
              uint(1),
              uint(TOPLEVEL_INFO_ID)
            ),
            message(DISPLAY, 0, uint(TOPLEVELS_LISTED)),
          ])
        );
      } else if (objectId === TOPLEVEL_INFO_ID && opcode === 0) {
        // zcosmic_toplevel_info_v1.toplevel: the new handle's id
        toplevels.set(body.readUInt32LE(0), { appId: null, activated: false });
      } else if (toplevels.has(objectId) && opcode === 3) {
        // zcosmic_toplevel_handle_v1.app_id
        toplevels.get(objectId).appId = readString(body, 0);
      } else if (toplevels.has(objectId) && opcode === 8) {
        // zcosmic_toplevel_handle_v1.state: an array of uint32 states
        const states = readBytes(body, 0);
        for (let offset = 0; offset + 4 <= states.length; offset += 4) {
          if (states.readUInt32LE(offset) === STATE_ACTIVATED) {
            toplevels.get(objectId).activated = true;
          }
        }
      } else if (objectId === TOPLEVELS_LISTED) {
        const active = [...toplevels.values()].find((toplevel) => toplevel.activated);
        finish(active?.appId?.toLowerCase() || null);
      }
    };

    socket.on("connect", () => {
      // wl_display.get_registry, then wl_display.sync
      socket.write(
        Buffer.concat([
          message(DISPLAY, 1, uint(REGISTRY)),
          message(DISPLAY, 0, uint(GLOBALS_LISTED)),
        ])
      );
    });
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      try {
        while (pending.length >= 8) {
          const size = pending.readUInt32LE(4) >>> 16;
          if (size < 8 || pending.length < size) break;
          handleEvent(
            pending.readUInt32LE(0),
            pending.readUInt32LE(4) & 0xffff,
            pending.subarray(8, size)
          );
          pending = pending.subarray(size);
        }
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

module.exports = { getCosmicActiveAppId };
