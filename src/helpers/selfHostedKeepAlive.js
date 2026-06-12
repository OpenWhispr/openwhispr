const http = require("http");
const https = require("https");
const debugLogger = require("./debugLogger");

const INTERVAL_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SAMPLE_RATE = 16000;
const SILENCE_DURATION_S = 0.1;
const NUM_SAMPLES = Math.floor(SAMPLE_RATE * SILENCE_DURATION_S);

function buildSilentWav() {
  const dataSize = NUM_SAMPLES * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const SILENT_WAV = buildSilentWav();
const BOUNDARY = "----OpenWhisprKeepAlive";

class SelfHostedKeepAlive {
  constructor() {
    this._timer = null;
    this._url = null;
    this._model = null;
  }

  start(serverUrl) {
    if (!serverUrl || !serverUrl.trim()) return;

    const normalized = serverUrl.trim().replace(/\/+$/, "");
    if (this._url === normalized && this._timer) return;

    this.stop();
    this._url = normalized;
    this._model = null;
    this._ping();
    this._timer = setInterval(() => this._ping(), INTERVAL_MS);
    debugLogger.debug("Self-hosted keep-alive started", { url: this._url, intervalMs: INTERVAL_MS });
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      debugLogger.debug("Self-hosted keep-alive stopped", { url: this._url });
    }
    this._url = null;
    this._model = null;
  }

  isRunning() {
    return this._timer !== null;
  }

  _ping() {
    if (!this._url) return;

    if (!this._model) {
      this._fetchModelThenTranscribe();
    } else {
      this._sendTranscription();
    }
  }

  _fetchModelThenTranscribe() {
    let target;
    try {
      target = new URL(this._url + "/models");
    } catch {
      return;
    }

    const client = target.protocol === "https:" ? https : http;
    const req = client.get(target, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const firstModel = data?.data?.[0]?.id;
          if (firstModel) {
            this._model = firstModel;
            debugLogger.debug("Self-hosted keep-alive resolved model", { model: this._model });
            this._sendTranscription();
          }
        } catch {
          // malformed response, skip
        }
      });
    });
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
  }

  _sendTranscription() {
    if (!this._url || !this._model) return;

    let target;
    try {
      target = new URL(this._url + "/audio/transcriptions");
    } catch {
      return;
    }

    const parts = [
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="keepalive.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`,
      SILENT_WAV,
      `\r\n--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `${this._model}\r\n` +
        `--${BOUNDARY}--\r\n`,
    ];

    const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
    const body = Buffer.concat(bodyParts);

    const client = target.protocol === "https:" ? https : http;
    const req = client.request(
      target,
      {
        method: "POST",
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
          "Content-Length": body.length,
        },
      },
      (res) => { res.resume(); }
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end(body);
  }
}

module.exports = SelfHostedKeepAlive;
