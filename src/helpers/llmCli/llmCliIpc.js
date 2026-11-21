// Thin IPC adapter for the subscription-CLI seats. Registered from
// main.js through one require and one call. All decisions live in
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

function registerLlmCliIpc({
  ipcMain,
  runner,
  detector,
  installer,
  signIn,
  prefs,
  onQuit = () => {},
  emitEvent = () => {},
  logger = {},
}) {
  const streamAborts = new Map(); // streamId -> AbortController

  // The Claude seat stays off until the setting is on. Enforced here, on every
  // claude entry point, whatever the renderer sends.
  const gated = (seat) =>
    seat === "claude" && !policy.isSeatEnabled("claude", prefs.get())
      ? { success: false, ok: false, code: "claude-disabled", error: "claude-disabled" }
      : null;

  // An app quit must not leave a CLI process behind.
  onQuit(() => {
    runner.cancelAll?.();
    installer.cancelAll?.();
    void signIn.cancelAll?.();
  });

  ipcMain.handle("llm-cli-get-prefs", async () => prefs.get());

  ipcMain.handle("llm-cli-set-pref", async (_event, key, value) => {
    const next = prefs.set(key, value);
    if (!next) return invalid("unsupported preference");
    if (key === "claudeEnabled" && value === false) {
      runner.cancel?.("claude");
      void signIn.cancel?.("claude");
    }
    return { success: true, prefs: next };
  });

  // Seat state changes (detect, test, install, sign-in) reach every window.
  detector.onChange((seat, state) => emitEvent({ type: "state", seat, state }));

  ipcMain.handle("llm-cli-detect", async () => detector.detectAll());

  ipcMain.handle("llm-cli-test", async (_event, seat) => {
    if (!isSeat(seat)) return invalid("unknown seat");
    return gated(seat) || detector.testSeat(seat);
  });

  // The only renderer value accepted is the url the consent dialog displayed;
  // the installer compares it byte-for-byte with the policy table.
  ipcMain.handle("llm-cli-install-start", async (_event, seat, consentedUrl) => {
    if (!isSeat(seat) || typeof consentedUrl !== "string" || consentedUrl.length > 2048) {
      return invalid("invalid install request");
    }
    return installer.install({ seat, consentedUrl, onProgress: emitEvent });
  });

  ipcMain.handle("llm-cli-install-cancel", async (_event, seat) => {
    if (isSeat(seat)) installer.cancel(seat);
  });

  // Sign-in runs in the background; its outcome arrives as a signin-result
  // event next to the state events. Nothing returned or emitted carries a token.
  ipcMain.handle("llm-cli-signin-start", async (_event, seat) => {
    if (!isSeat(seat)) return invalid("unknown seat");
    const blocked = gated(seat);
    if (blocked) return blocked;
    const { done, ...started } = await signIn.start({ seat });
    if (done) {
      void done.then((result) =>
        emitEvent({ type: "signin-result", seat, ok: result.ok, code: result.code })
      );
    }
    return started;
  });

  ipcMain.handle("llm-cli-signin-submit-code", async (_event, seat, code) => {
    if (!isSeat(seat) || typeof code !== "string") return invalid("invalid code submission");
    return signIn.submitCode({ seat, code });
  });

  ipcMain.handle("llm-cli-signin-cancel", async (_event, seat) => {
    if (isSeat(seat)) await signIn.cancel(seat);
  });

  ipcMain.handle("llm-cli-signout", async (_event, seat) => {
    if (!isSeat(seat)) return invalid("unknown seat");
    return signIn.signOut({ seat });
  });

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
    const blocked = gated(seat);
    if (blocked) {
      if (!event.sender.isDestroyed()) {
        event.sender.send("llm-cli-stream-part", {
          streamId,
          error: blocked.error,
          code: blocked.code,
        });
      }
      return blocked;
    }

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

// Composition root, called once from main.js. Electron is required here
// only so the adapter above stays testable without it.
function initLlmCliIpc({ logger } = {}) {
  const path = require("path");
  const { app, ipcMain, BrowserWindow, safeStorage, shell } = require("electron");
  const { createRunner } = require("./llmCliRunner");
  const { createDetector } = require("./llmCliDetect");
  const { createInstaller } = require("./llmCliInstaller");
  const { createSignIn } = require("./llmCliSignIn");
  const { createTokenStore } = require("./llmCliTokenStore");
  const { createPrefs } = require("./llmCliPrefs");

  const log = (...args) => logger?.debug?.(...args);
  const tokenStore = createTokenStore({
    safeStorage,
    dir: path.join(app.getPath("userData"), "secure-keys"),
  });
  const holder = { detector: null };
  const runner = createRunner({
    resolveExe: (seat) => holder.detector.resolveExe(seat),
    getClaudeToken: async () => tokenStore.load(),
    log,
  });
  const detector = createDetector({ runner, tokenStore, log });
  holder.detector = detector;
  const installer = createInstaller({ detector, log });

  const emitEvent = (event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("llm-cli-event", event);
    }
  };
  const signIn = createSignIn({
    detector,
    tokenStore,
    openExternal: (url) => shell.openExternal(url),
    emit: emitEvent,
    log,
  });
  const prefs = createPrefs({
    file: path.join(app.getPath("userData"), "llm-cli-prefs.json"),
    log,
  });
  registerLlmCliIpc({
    ipcMain,
    runner,
    detector,
    installer,
    signIn,
    prefs,
    onQuit: (fn) => app.on("before-quit", fn),
    emitEvent,
    logger,
  });
  return { runner, detector, installer, signIn };
}

module.exports = { registerLlmCliIpc, initLlmCliIpc, SEATS, isSeat };
