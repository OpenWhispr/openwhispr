const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");

const PORT_RANGE_START = 8200;
const PORT_RANGE_END = 8219;
const HOST = "127.0.0.1";
const BRIDGE_FILE_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const NO_CONTENT = Symbol("CliBridge.NoContent");

function getBridgeFilePath() {
  return path.join(os.homedir(), ".openwhispr", "cli-bridge.json");
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, HOST);
  });
}

async function findAvailablePort() {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_REQUEST_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

function sendV1Error(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

function parseIdParam(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function unwrapMutationResult(result, label) {
  if (!result?.success || !result[label]) {
    throw new Error(result?.error || `Failed to write ${label}`);
  }
  return result[label];
}

class CliBridge {
  constructor(ipcHandlers) {
    this.ipcHandlers = ipcHandlers;
    this.server = null;
    this.port = null;
    this.token = null;
    this.bridgeFilePath = getBridgeFilePath();
    this.routes = this._buildRouteTable();
  }

  async start() {
    if (this.server) return;

    this.token = crypto.randomBytes(32).toString("hex");
    this.port = await findAvailablePort();
    this.server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        debugLogger.error("CLI bridge handler error", { error: err.message }, "cli-bridge");
        if (!res.headersSent) {
          sendV1Error(res, 500, "internal_error", "Internal server error");
        }
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        reject(err);
      };
      this.server.once("error", onError);
      this.server.listen(this.port, HOST, () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });

    this._writeBridgeFile();
    debugLogger.info("CLI bridge started", { port: this.port }, "cli-bridge");
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => {
      this.server.close(() => resolve());
    });
    this.server = null;
    this.port = null;
    this.token = null;
    this._removeBridgeFile();
    debugLogger.info("CLI bridge stopped", {}, "cli-bridge");
  }

  _writeBridgeFile() {
    const dir = path.dirname(this.bridgeFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({
      version: BRIDGE_FILE_VERSION,
      port: this.port,
      token: this.token,
    });
    fs.writeFileSync(this.bridgeFilePath, payload, { mode: 0o600 });
    // Re-apply mode in case the filesystem ignored the mode arg on create.
    // No-op on Windows ACLs but harmless; swallow errors from exotic filesystems.
    try {
      fs.chmodSync(this.bridgeFilePath, 0o600);
    } catch (err) {
      debugLogger.debug("CLI bridge chmod failed", { error: err.message }, "cli-bridge");
    }
  }

  _removeBridgeFile() {
    try {
      fs.unlinkSync(this.bridgeFilePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        debugLogger.debug("CLI bridge file removal failed", { error: err.message }, "cli-bridge");
      }
    }
  }

  async _handleRequest(req, res) {
    const remote = req.socket?.remoteAddress;
    if (!remote || !LOOPBACK_ADDRESSES.has(remote)) {
      sendV1Error(res, 403, "forbidden", "Forbidden");
      return;
    }

    const auth = req.headers["authorization"] || "";
    const expected = `Bearer ${this.token}`;
    if (
      auth.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      sendV1Error(res, 401, "unauthorized", "Unauthorized");
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${this.port}`);
    const route = this._matchRoute(req.method, url.pathname);
    if (!route) {
      sendV1Error(res, 404, "not_found", "Not found");
      return;
    }

    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendV1Error(res, 400, "validation_error", err.message);
        return;
      }
    }

    try {
      const result = await route.handler({ params: route.params, query: url.searchParams, body });
      if (result === NO_CONTENT) {
        sendNoContent(res);
        return;
      }
      const status = route.status || 200;
      sendJson(res, status, result);
    } catch (err) {
      this._sendError(res, err);
    }
  }

  _sendError(res, err) {
    if (err.code === "NOT_FOUND") {
      sendV1Error(res, 404, "not_found", err.message);
      return;
    }
    debugLogger.error("CLI bridge route error", { error: err.message }, "cli-bridge");
    sendV1Error(res, 500, "internal_error", err.message || "Internal server error");
  }

  _matchRoute(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = route.match(pathname);
      if (params) return { ...route, params };
    }
    return null;
  }

  _buildRouteTable() {
    const exact = (method, path, handler, status) => ({
      method,
      match: (p) => (p === path ? {} : null),
      handler,
      status,
    });
    const param = (method, prefix, suffix, paramName, handler, status) => ({
      method,
      match: (p) => {
        if (!p.startsWith(prefix)) return null;
        const rest = p.slice(prefix.length);
        if (suffix) {
          if (!rest.endsWith(suffix)) return null;
          const value = rest.slice(0, rest.length - suffix.length);
          if (!value || value.includes("/")) return null;
          return { [paramName]: value };
        }
        if (rest.includes("/")) return null;
        return { [paramName]: rest };
      },
      handler,
      status,
    });

    const db = this.ipcHandlers.databaseManager;
    const ipc = this.ipcHandlers;

    const requireId = (params, label) => {
      const id = parseIdParam(params.id);
      if (id == null) {
        const err = new Error(`Invalid ${label} id`);
        err.code = "NOT_FOUND";
        throw err;
      }
      return id;
    };

    const requireSuccess = (result, message) => {
      if (!result?.success) {
        const err = new Error(result?.error || message);
        err.code = "NOT_FOUND";
        throw err;
      }
    };

    return [
      exact("GET", "/v1/health", () => ({ data: { ok: true, version: 1 } })),
      exact("GET", "/v1/notes/list", ({ query }) => {
        const noteType = query.get("note_type") || null;
        const limit = query.get("limit") ? Number(query.get("limit")) : 100;
        const folderId = query.get("folder_id") ? Number(query.get("folder_id")) : null;
        const notes = db.getNotes(noteType, limit, folderId);
        return { data: notes, has_more: false, next_cursor: null };
      }),
      exact("GET", "/v1/notes/search", ({ query }) => {
        const q = query.get("q") || "";
        if (!q.trim()) {
          const err = new Error("Search query is required");
          err.code = "VALIDATION";
          throw err;
        }
        const limit = query.get("limit") ? Number(query.get("limit")) : 20;
        const notes = db.searchNotes(q, limit);
        return { data: notes, has_more: false, next_cursor: null };
      }),
      param("GET", "/v1/notes/", "", "id", ({ params }) => {
        const id = requireId(params, "note");
        const note = db.getNote(id);
        if (!note || note.deleted_at) {
          const err = new Error(`Note ${id} not found`);
          err.code = "NOT_FOUND";
          throw err;
        }
        return { data: note };
      }),
      exact(
        "POST",
        "/v1/notes/create",
        ({ body }) => {
          const result = db.saveNote(
            body.title ?? "Untitled Note",
            body.content ?? "",
            body.note_type ?? "personal",
            body.source_file ?? null,
            body.audio_duration_seconds ?? null,
            body.folder_id ?? null
          );
          const note = unwrapMutationResult(result, "note");
          setImmediate(() => ipc.broadcastToWindows("note-added", note));
          ipc._asyncVectorUpsert(note);
          ipc._asyncMirrorWrite(note);
          return { data: note };
        },
        201
      ),
      param("PATCH", "/v1/notes/", "", "id", ({ params, body }) => {
        const id = requireId(params, "note");
        const result = db.updateNote(id, body || {});
        const note = unwrapMutationResult(result, "note");
        setImmediate(() => ipc.broadcastToWindows("note-updated", note));
        ipc._asyncVectorUpsert(note);
        ipc._asyncMirrorWrite(note);
        return { data: note };
      }),
      param("DELETE", "/v1/notes/", "", "id", ({ params }) => {
        const id = requireId(params, "note");
        const result = ipc.deleteNoteInternal(id);
        requireSuccess(result, `Note ${id} not found`);
        return NO_CONTENT;
      }),
      exact("GET", "/v1/folders/list", () => {
        return { data: db.getFolders(), has_more: false, next_cursor: null };
      }),
      exact(
        "POST",
        "/v1/folders/create",
        ({ body }) => {
          const result = db.createFolder(body?.name);
          const folder = unwrapMutationResult(result, "folder");
          setImmediate(() => ipc.broadcastToWindows("folder-created", folder));
          return { data: folder };
        },
        201
      ),
      exact("GET", "/v1/transcriptions/list", ({ query }) => {
        const limit = query.get("limit") ? Number(query.get("limit")) : 50;
        return {
          data: db.getTranscriptions(limit),
          has_more: false,
          next_cursor: null,
        };
      }),
      param("GET", "/v1/transcriptions/", "", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const transcription = db.getTranscriptionById(id);
        if (!transcription || transcription.deleted_at) {
          const err = new Error(`Transcription ${id} not found`);
          err.code = "NOT_FOUND";
          throw err;
        }
        return { data: transcription };
      }),
      param("DELETE", "/v1/transcriptions/", "", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const result = ipc.deleteTranscriptionInternal(id);
        requireSuccess(result, `Transcription ${id} not found`);
        return NO_CONTENT;
      }),
      param("DELETE", "/v1/transcriptions/", "/audio", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const result = ipc.audioStorageManager.deleteAudio(id);
        if (!result?.success) {
          throw new Error(`Failed to delete audio for transcription ${id}`);
        }
        db.updateTranscriptionAudio(id, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
        return NO_CONTENT;
      }),
    ];
  }
}

module.exports = CliBridge;
module.exports.getBridgeFilePath = getBridgeFilePath;
