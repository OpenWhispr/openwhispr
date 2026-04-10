const EventEmitter = require("events");
const crypto = require("crypto");
const WebSocket = require("ws");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { loadOrCreateDeviceIdentity, buildDeviceAuthBlock } = require("./openClawIdentity");

const PROTOCOL_VERSION = 3;
const CONNECT_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 30000;
const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function extractChatText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

class OpenClawClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.url = config.url || "ws://127.0.0.1:18789";
    this.token = config.token || "";
    this.ssh = config.ssh || null;
    this.ws = null;
    this.status = "disconnected";
    this.pendingRequests = new Map();
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.userInitiatedDisconnect = false;
    this.activeSessionKey = null;
    this.pendingRunIds = new Set();
    this.runTextBuffers = new Map();
    this._challengeWaiter = null;
  }

  updateConfig(config = {}) {
    if (config.url) this.url = config.url;
    if (config.token !== undefined) this.token = config.token;
    if (config.ssh !== undefined) this.ssh = config.ssh;
  }

  isConnected() {
    return this.status === "connected";
  }

  getStatus() {
    return this.status;
  }

  _setStatus(next) {
    if (this.status === next) return;
    this.status = next;
    this.emit("status-change", next);
  }

  async connect() {
    if (this.status === "connected" || this.status === "connecting") return;
    this.userInitiatedDisconnect = false;
    this._clearReconnectTimer();
    await this._openSocket();
  }

  async disconnect() {
    this.userInitiatedDisconnect = true;
    this._clearReconnectTimer();
    this._failAllPending(new Error("Disconnected"));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this._setStatus("disconnected");
  }

  async _openSocket() {
    this._setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    return new Promise((resolve, reject) => {
      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleErr = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        this._setStatus("error");
        this.emit("connection-error", { code: "ws-open-failed", message: err.message });
        settleErr(err);
        this._scheduleReconnect();
        return;
      }

      this.ws = ws;

      const connectTimeout = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        const err = new Error("OpenClaw connect timeout");
        this._setStatus("error");
        this.emit("connection-error", { code: "connect-timeout", message: err.message });
        settleErr(err);
        this._scheduleReconnect();
      }, CONNECT_TIMEOUT_MS);

      ws.on("open", async () => {
        try {
          await this._performHandshake();
          clearTimeout(connectTimeout);
          this.reconnectAttempt = 0;
          this._setStatus("connected");
          settleOk();
        } catch (err) {
          clearTimeout(connectTimeout);
          this._setStatus("error");
          this.emit("connection-error", { code: "handshake-failed", message: err.message });
          try {
            ws.close();
          } catch {}
          settleErr(err);
          this._scheduleReconnect();
        }
      });

      ws.on("message", (data) => {
        this._handleFrame(data);
      });

      ws.on("error", (err) => {
        debugLogger.debug("OpenClaw WebSocket error", { error: err.message }, "openclaw");
        this.emit("connection-error", { code: "ws-error", message: err.message });
      });

      ws.on("close", (code, reason) => {
        clearTimeout(connectTimeout);
        const wasConnected = this.status === "connected";
        this._failAllPending(new Error("Connection closed"));
        this.ws = null;
        debugLogger.debug(
          "OpenClaw WebSocket closed",
          { code, reason: reason?.toString(), wasConnected },
          "openclaw"
        );
        settleErr(new Error(`Connection closed (code ${code})`));
        if (this.userInitiatedDisconnect) {
          this._setStatus("disconnected");
          return;
        }
        this._scheduleReconnect();
      });
    });
  }

  async _performHandshake() {
    const challenge = await this._waitForChallenge(CONNECT_TIMEOUT_MS);
    const clientId = "cli";
    const clientMode = "cli";
    const role = "operator";
    const scopes = ["operator.read", "operator.write"];
    const platform = process.platform;
    const identity = loadOrCreateDeviceIdentity();
    const device = buildDeviceAuthBlock({
      identity,
      clientId,
      clientMode,
      role,
      scopes,
      token: this.token,
      platform,
      deviceFamily: "desktop",
      nonce: challenge.nonce,
      signedAtMs: challenge.ts,
    });
    const params = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: clientId,
        displayName: "OpenWhispr",
        version: app.getVersion(),
        platform,
        deviceFamily: "desktop",
        mode: clientMode,
      },
      role,
      scopes,
      auth: { token: this.token },
      device,
    };
    const payload = await this._sendRequest("connect", params, CONNECT_TIMEOUT_MS);
    if (!payload || payload.type !== "hello-ok") {
      throw new Error("Unexpected handshake response");
    }
    return payload;
  }

  _waitForChallenge(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._challengeWaiter = null;
        reject(new Error("Timed out waiting for connect challenge"));
      }, timeoutMs);
      this._challengeWaiter = (challenge) => {
        clearTimeout(timer);
        this._challengeWaiter = null;
        resolve(challenge);
      };
    });
  }

  _sendRequest(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("OpenClaw not connected"));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`OpenClaw request ${method} timed out`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  _handleFrame(data) {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch (err) {
      debugLogger.debug("OpenClaw frame parse error", { error: err.message }, "openclaw");
      return;
    }

    if (frame.type === "res") {
      const pending = this.pendingRequests.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        const message = frame.error?.message || "OpenClaw request failed";
        pending.reject(new Error(message));
      }
      return;
    }

    if (frame.type === "event") {
      this._handleEvent(frame);
    }
  }

  _handleEvent(frame) {
    const eventName = frame.event;
    const payload = frame.payload || {};
    const sessionKey = payload.sessionKey || payload.session_key || null;

    if (eventName === "connect.challenge") {
      const waiter = this._challengeWaiter;
      if (waiter) {
        waiter({ nonce: payload.nonce, ts: payload.ts });
      }
      return;
    }

    switch (eventName) {
      case "sessions.changed":
        this.emit("sessions-changed");
        return;
      case "tick":
      case "health":
      case "presence":
        return;
      case "session.tool": {
        const messageId = payload.messageId || payload.message_id;
        if (payload.phase === "result") {
          this.emit("tool-result", {
            sessionKey,
            messageId,
            tool: payload.tool,
            output: payload.output,
          });
        } else {
          this.emit("tool-call", {
            sessionKey,
            messageId,
            tool: payload.tool,
            input: payload.input,
          });
        }
        return;
      }
      case "session.message":
      case "chat": {
        const runId = payload.runId || payload.messageId || payload.message_id;
        const state = payload.state;
        const fullText = extractChatText(payload.message);
        const role = payload.message?.role || "assistant";
        if (state === "delta") {
          const previous = this.runTextBuffers.get(runId) || "";
          const delta = fullText.slice(previous.length);
          if (delta.length > 0) {
            this.runTextBuffers.set(runId, fullText);
            this.emit("message-chunk", { sessionKey, messageId: runId, delta });
          }
          return;
        }
        if (state === "final" || state === "aborted") {
          const accumulated = this.runTextBuffers.get(runId) || "";
          this.runTextBuffers.delete(runId);
          const content = fullText || accumulated;
          if (this._isOurRun(runId)) {
            this._completeRun(runId);
            this.emit("message-done", {
              sessionKey,
              messageId: runId,
              content,
            });
          } else {
            this.emit("proactive-message", {
              sessionKey,
              messageId: runId,
              role,
              content,
              channel: payload.channel,
            });
          }
          return;
        }
        if (state === "error") {
          this.runTextBuffers.delete(runId);
          this._completeRun(runId);
          this.emit("message-done", {
            sessionKey,
            messageId: runId,
            content: payload.errorMessage || "Error",
          });
          return;
        }
        return;
      }
      default:
        return;
    }
  }

  _isOurRun(runId) {
    return this.pendingRunIds.has(runId);
  }

  _completeRun(runId) {
    this.pendingRunIds.delete(runId);
  }

  _failAllPending(err) {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this.userInitiatedDisconnect) return;
    this._clearReconnectTimer();
    const delay =
      BACKOFF_STEPS_MS[Math.min(this.reconnectAttempt, BACKOFF_STEPS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this._setStatus("reconnecting");
    debugLogger.debug(
      "OpenClaw scheduling reconnect",
      { attempt: this.reconnectAttempt, delayMs: delay },
      "openclaw"
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._openSocket().catch(() => {});
    }, delay);
  }

  async listSessions() {
    const payload = await this._sendRequest("sessions.list", {
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    const rows = payload?.sessions || [];
    return rows.map((row) => ({
      sessionKey: row.key,
      title: row.label || row.derivedTitle || row.displayName || row.key,
      channel: row.deliveryContext?.channel || row.origin?.channel,
      lastActivity: row.updatedAt,
      preview: row.lastMessagePreview,
    }));
  }

  async createSession({ label, key } = {}) {
    const requestedKey = key || `openwhispr-${crypto.randomUUID()}`;
    const params = { key: requestedKey };
    if (label) params.label = label;
    const result = await this._sendRequest("sessions.create", params);
    return result?.key || requestedKey;
  }

  setActiveSession(sessionKey) {
    this.activeSessionKey = sessionKey || null;
  }

  getActiveSession() {
    return this.activeSessionKey;
  }

  async getHistory(sessionKey, opts = {}) {
    const payload = await this._sendRequest("chat.history", { sessionKey, ...opts });
    return { messages: payload?.messages || [] };
  }

  async sendMessage(sessionKey, text) {
    const runId = crypto.randomUUID();
    this.pendingRunIds.add(runId);
    const payload = await this._sendRequest("chat.send", {
      sessionKey,
      message: text,
      idempotencyKey: runId,
    });
    return { messageId: payload?.messageId || payload?.message_id || runId };
  }

  async abort(sessionKey) {
    await this._sendRequest("chat.abort", { sessionKey });
  }
}

module.exports = OpenClawClient;
