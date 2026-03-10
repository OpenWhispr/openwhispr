const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { findAvailablePort } = require("../utils/serverUtils");

const MCP_BRIDGE_PORT_START = 19876;
const MCP_BRIDGE_PORT_END = 19899;
const MCP_BRIDGE_HOST = "127.0.0.1";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MB

/**
 * MCPBridge exposes a local HTTP API that the standalone MCP server can call
 * to interact with the running Electron application.  It bridges MCP tool
 * invocations to the existing manager layer (database, window, whisper, etc.).
 *
 * The bridge writes its port to a well-known file so the MCP server can
 * discover it without any manual configuration.
 */
class MCPBridge {
  /**
   * @param {object} deps
   * @param {import("./database")} deps.databaseManager
   * @param {import("./windowManager")} deps.windowManager
   * @param {import("./whisper")} deps.whisperManager
   * @param {import("./parakeet")} deps.parakeetManager
   * @param {import("./environment")} deps.environmentManager
   */
  constructor({ databaseManager, windowManager, whisperManager, parakeetManager, environmentManager }) {
    this.databaseManager = databaseManager;
    this.windowManager = windowManager;
    this.whisperManager = whisperManager;
    this.parakeetManager = parakeetManager;
    this.environmentManager = environmentManager;

    this.server = null;
    this.port = null;
    this.authToken = null;
    this.portFilePath = path.join(app.getPath("userData"), "mcp-bridge-port");
    this.tokenFilePath = path.join(app.getPath("userData"), "mcp-bridge-token");
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    if (this.server) return;

    try {
      this.port = await findAvailablePort(MCP_BRIDGE_PORT_START, MCP_BRIDGE_PORT_END);
    } catch (err) {
      debugLogger.warn("MCPBridge: no available port", { error: err.message });
      return;
    }

    // Generate a random auth token for this session
    this.authToken = crypto.randomBytes(32).toString("hex");

    this.server = http.createServer((req, res) => this._handleRequest(req, res));

    this.server.on("error", (error) => {
      debugLogger.error("MCPBridge server error", { error: error.message });
    });

    await new Promise((resolve, reject) => {
      this.server.listen(this.port, MCP_BRIDGE_HOST, () => {
        debugLogger.info("MCPBridge started", {
          url: `http://${MCP_BRIDGE_HOST}:${this.port}`,
        });
        resolve();
      });
      this.server.once("error", reject);
    });

    // Write port file so the MCP server can discover us
    try {
      fs.writeFileSync(this.portFilePath, String(this.port), "utf-8");
      debugLogger.debug("MCPBridge port file written", { path: this.portFilePath });
    } catch (err) {
      debugLogger.warn("MCPBridge: failed to write port file", { error: err.message });
    }

    // Write token file so the MCP server can authenticate
    try {
      fs.writeFileSync(this.tokenFilePath, this.authToken, "utf-8");
      debugLogger.debug("MCPBridge token file written", { path: this.tokenFilePath });
    } catch (err) {
      debugLogger.warn("MCPBridge: failed to write token file", { error: err.message });
    }
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      debugLogger.debug("MCPBridge stopped");
    }

    // Clean up port file
    try {
      if (fs.existsSync(this.portFilePath)) {
        fs.unlinkSync(this.portFilePath);
      }
    } catch {
      // ignore cleanup errors
    }

    // Clean up token file
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        fs.unlinkSync(this.tokenFilePath);
      }
    } catch {
      // ignore cleanup errors
    }

    this.port = null;
    this.authToken = null;
  }

  getPort() {
    return this.port;
  }

  // ---------------------------------------------------------------------------
  // HTTP plumbing
  // ---------------------------------------------------------------------------

  async _handleRequest(req, res) {
    // Only accept requests from localhost
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1" && remoteAddress !== "::ffff:127.0.0.1") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    // Validate auth token
    if (this.authToken) {
      const authHeader = req.headers.authorization || "";
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      const token = match ? match[1] : null;
      if (token !== this.authToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    const url = new URL(req.url || "/", `http://${MCP_BRIDGE_HOST}:${this.port}`);
    const pathname = url.pathname;
    const method = req.method;

    debugLogger.debug("MCPBridge request", { method, pathname });

    try {
      if (method === "GET") {
        switch (pathname) {
          case "/status":
            return this._sendJson(res, this._getStatus());
          case "/transcriptions":
            return this._sendJson(res, this._getTranscriptions(url.searchParams));
          case "/command-history":
            return this._sendJson(res, this._getCommandHistory(url.searchParams));
          case "/command-stats":
            return this._sendJson(res, this._getCommandStats());
          case "/search-commands":
            return this._sendJson(res, this._searchCommands(url.searchParams));
          default:
            return this._sendNotFound(res);
        }
      }

      if (method === "POST") {
        const body = await this._parseJsonBody(req);
        switch (pathname) {
          case "/transcribe":
            return this._sendJson(res, await this._transcribe(body));
          case "/start-dictation":
            return this._sendJson(res, this._startDictation());
          case "/stop-dictation":
            return this._sendJson(res, this._stopDictation());
          default:
            return this._sendNotFound(res);
        }
      }

      this._sendNotFound(res);
    } catch (err) {
      debugLogger.error("MCPBridge handler error", { error: err.message, pathname });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  _sendJson(res, data) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  _sendNotFound(res) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  /**
   * Parse a JSON request body with size limits.
   */
  _parseJsonBody(req) {
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

  // ---------------------------------------------------------------------------
  // Route handlers
  // ---------------------------------------------------------------------------

  _getStatus() {
    const version = app.getVersion();
    const whisperStatus = this.whisperManager?.serverManager?.getStatus?.() || {};
    const parakeetStatus = this.parakeetManager?.serverManager?.getStatus?.() || {};
    const localProvider = process.env.LOCAL_TRANSCRIPTION_PROVIDER || "whisper";
    const activationMode = this.environmentManager.getActivationMode();

    const model =
      localProvider === "nvidia"
        ? parakeetStatus.modelName || null
        : whisperStatus.modelName || null;

    return {
      running: true,
      version,
      model,
      provider: localProvider,
      activationMode,
      whisper: whisperStatus,
      parakeet: parakeetStatus,
    };
  }

  _getTranscriptions(params) {
    const limit = Math.min(Math.max(parseInt(params.get("limit"), 10) || 50, 1), 500);
    const offset = Math.max(parseInt(params.get("offset"), 10) || 0, 0);

    // DatabaseManager.getTranscriptions only supports a limit parameter.
    // We apply offset manually for the MCP interface.
    const all = this.databaseManager.getTranscriptions(limit + offset);
    return all.slice(offset, offset + limit);
  }

  _getCommandHistory(params) {
    const limit = Math.min(Math.max(parseInt(params.get("limit"), 10) || 50, 1), 500);
    const offset = Math.max(parseInt(params.get("offset"), 10) || 0, 0);
    const status = params.get("status") || null;
    const provider = params.get("provider") || null;
    const source = params.get("source") || null;
    const startDate = params.get("startDate") || null;
    const endDate = params.get("endDate") || null;

    return this.databaseManager.getCommandHistory({
      limit,
      offset,
      status,
      provider,
      source,
      startDate,
      endDate,
    });
  }

  _getCommandStats() {
    return this.databaseManager.getCommandStats();
  }

  _searchCommands(params) {
    const query = params.get("q") || "";
    const limit = Math.min(Math.max(parseInt(params.get("limit"), 10) || 50, 1), 500);

    return this.databaseManager.searchCommandHistory(query, limit);
  }

  async _transcribe(body) {
    const { filePath } = body;
    if (!filePath) {
      throw new Error("filePath is required");
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const audioBuffer = fs.readFileSync(filePath);
    const localProvider = process.env.LOCAL_TRANSCRIPTION_PROVIDER || "whisper";

    let result;
    if (localProvider === "nvidia") {
      result = await this.parakeetManager.transcribeLocalParakeet(audioBuffer, {});
    } else {
      result = await this.whisperManager.transcribeLocalWhisper(audioBuffer, {});
    }

    return result;
  }

  _startDictation() {
    if (!this.windowManager.mainWindow || this.windowManager.mainWindow.isDestroyed()) {
      return { success: false, error: "Dictation window not available" };
    }

    this.windowManager.showDictationPanel();
    this.windowManager.sendStartDictation();
    return { success: true };
  }

  _stopDictation() {
    if (!this.windowManager.mainWindow || this.windowManager.mainWindow.isDestroyed()) {
      return { success: false, error: "Dictation window not available" };
    }

    this.windowManager.sendStopDictation();
    return { success: true };
  }
}

module.exports = MCPBridge;
