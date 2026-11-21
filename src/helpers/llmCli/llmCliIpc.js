// Thin IPC adapter for the subscription-CLI seats. Registered from
// ipcHandlers.js through one require and one call. All decisions live in
// ../llmCliProviders and the sibling modules; this file validates renderer
// input (seat enum, size caps) and relays results. Every error string that
// crosses IPC passes redactSecrets.
const policy = require("../llmCliProviders");

const SEATS = Object.freeze(policy.LLM_CLI_PROVIDERS.map((p) => p.seat));
const PAYLOAD_CAP_CHARS = 1024 * 1024;
const STREAM_ID_MAX = 128;

function isSeat(value) {
  return typeof value === "string" && SEATS.includes(value);
}

function payloadTooLarge(payload) {
  try {
    return JSON.stringify(payload ?? null).length > PAYLOAD_CAP_CHARS;
  } catch {
    return true;
  }
}

function invalid(message) {
  return { success: false, code: "invalid-input", error: message };
}

function registerLlmCliIpc({ ipcMain, runner, logger = {} }) {
  const streamAborts = new Map(); // streamId -> AbortController

  // Mirrors enterprise-stream-start/part/cancel so the renderer shim in 08-03
  // reuses the same shape: parts are relayed verbatim, ending with {done} or
  // {error, code}.
  ipcMain.handle("llm-cli-stream-start", async (event, payload) => {
    if (!payload || typeof payload !== "object" || payloadTooLarge(payload)) {
      return invalid("invalid payload");
    }
    const { streamId, seat, modelId, prompt } = payload;
    if (typeof streamId !== "string" || !streamId || streamId.length > STREAM_ID_MAX) {
      return invalid("invalid streamId");
    }
    if (!isSeat(seat)) return invalid("unknown seat");
    if (modelId !== undefined && modelId !== null && typeof modelId !== "string") {
      return invalid("invalid modelId");
    }
    if (streamAborts.has(streamId)) return invalid("duplicate streamId");

    const send = (message) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("llm-cli-stream-part", { streamId, ...message });
      }
    };
    const abortController = new AbortController();
    streamAborts.set(streamId, abortController);
    const abortOnGone = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) abortController.abort();
    };
    const abortOnDestroyed = () => abortController.abort();
    event.sender.on("did-start-navigation", abortOnGone);
    event.sender.once("destroyed", abortOnDestroyed);
    try {
      const result = await runner.runStream({
        seat,
        modelId: modelId || undefined,
        prompt,
        signal: abortController.signal,
        onPart: (part) => send({ part }),
      });
      if (result.ok) {
        send({ done: true });
        return { success: true };
      }
      const error = policy.redactSecrets(result.message || result.code);
      send({ error, code: result.code });
      return { success: false, code: result.code, error };
    } catch (err) {
      logger.error?.("llm-cli stream failed", err && err.code);
      const error = policy.redactSecrets(String((err && err.message) || "stream failed"));
      send({ error, code: "exit-nonzero" });
      return { success: false, code: "exit-nonzero", error };
    } finally {
      streamAborts.delete(streamId);
      if (!event.sender.isDestroyed()) {
        event.sender.removeListener("did-start-navigation", abortOnGone);
        event.sender.removeListener("destroyed", abortOnDestroyed);
      }
    }
  });

  ipcMain.handle("llm-cli-stream-cancel", async (_event, streamId) => {
    if (typeof streamId !== "string") return;
    streamAborts.get(streamId)?.abort();
    streamAborts.delete(streamId);
  });
}

module.exports = { registerLlmCliIpc, SEATS, isSeat };
