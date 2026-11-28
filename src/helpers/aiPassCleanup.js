const fs = require("node:fs");
const path = require("node:path");

const ORIGIN = "https://aipass.one";
const CALLBACK_PORT = 43130;
const CALLBACK_PATH = "/auth/aipass/callback";
const SCOPE = "api:access";

function createTokenStore(file, { encrypt, decrypt }) {
  return {
    read() {
      try {
        return JSON.parse(decrypt(fs.readFileSync(file)).value);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error("Could not read the AI Pass connection.");
      }
    },
    write(tokens) {
      const encrypted = encrypt(JSON.stringify(tokens));
      fs.writeFileSync(file + ".tmp", encrypted, { mode: 0o600 });
      fs.renameSync(file + ".tmp", file);
    },
    clear() {
      fs.rmSync(file, { force: true });
    },
  };
}

function createAiPassCleanup({ clientId, store, fetch, runOAuth, canUse, now = Date.now }) {
  let pending = Promise.resolve();
  let models;
  const serialize = (task) => {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  };
  const configured = () => Boolean(clientId) && canUse();
  const authorize = () => {
    if (!configured()) throw new Error("AI Pass is unavailable.");
  };
  const request = (endpoint, options = {}) => {
    authorize();
    const timeout = AbortSignal.timeout(30000);
    return fetch(ORIGIN + endpoint, {
      ...options,
      redirect: "error",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  };
  const read = () => {
    const saved = store.read();
    return saved?.clientId === clientId ? saved : null;
  };
  const post = (endpoint, body, headers = {}, signal) =>
    request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });

  async function exchange(body) {
    const response = await post("/oauth2/token", { ...body, clientId });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (
        body.grantType === "refresh_token" &&
        (data?.error === "invalid_grant" || response.status === 400 || response.status === 401)
      ) {
        store.clear();
      }
      throw new Error("AI Pass authorization failed.");
    }
    if (
      typeof data?.access_token !== "string" ||
      !data.access_token ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    ) {
      throw new Error("AI Pass returned an invalid token response.");
    }
    authorize();
    const tokens = {
      clientId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now() + data.expires_in * 1000,
    };
    store.write(tokens);
    return tokens;
  }

  async function accessToken() {
    authorize();
    const saved = read();
    if (!saved) throw new Error("Connect AI Pass in Dictation Cleanup settings.");
    if (saved.expiresAt > now() + 30000) return saved.accessToken;
    const refreshed = await exchange({
      grantType: "refresh_token",
      refreshToken: saved.refreshToken,
    });
    return refreshed.accessToken;
  }

  async function listModels() {
    const response = await request("/v1/models?capability=text&method=chat_completions");
    if (!response.ok) throw new Error("Could not load AI Pass models.");
    const { data } = await response.json();
    const available = (Array.isArray(data) ? data : [])
      .filter(
        (model) =>
          typeof model?.id === "string" &&
          model.id &&
          model.capabilities?.includes("text") &&
          model.methods?.includes("chat_completions")
      )
      .map(({ id, name }) => ({ id, name: typeof name === "string" ? name : id }));
    models = { ids: new Set(available.map(({ id }) => id)), expiresAt: now() + 300000 };
    return available;
  }

  return {
    status() {
      if (!configured()) return { configured: false, connected: false };
      return { configured: true, connected: Boolean(read()) };
    },
    connect: () =>
      serialize(async () => {
        authorize();
        if (!read()) {
          store.assertAvailable?.();
          await runOAuth({
            ports: [CALLBACK_PORT],
            callbackPath: CALLBACK_PATH,
            errorParam: "aipass_error",
            requireStateOnError: true,
            renderResultPage: ({ ok }) =>
              ok ? "AI Pass connected. Return to OpenWhispr." : "AI Pass connection failed.",
            buildAuthUrl(redirectUri, state, codeChallenge) {
              const url = new URL("/oauth2/authorize", ORIGIN);
              url.search = new URLSearchParams({
                response_type: "code",
                client_id: clientId,
                redirect_uri: redirectUri,
                scope: SCOPE,
                state,
                code_challenge: codeChallenge,
                code_challenge_method: "S256",
              });
              return url.toString();
            },
            handleCallback: (code, redirectUri, codeVerifier) =>
              exchange({ grantType: "authorization_code", code, redirectUri, codeVerifier }),
          });
        }
      }),
    disconnect: () =>
      serialize(async () => {
        const saved = read();
        store.clear();
        if (!saved) return;
        const responses = await Promise.allSettled(
          [saved.refreshToken, saved.accessToken].map((token) =>
            request("/oauth2/revoke", {
              method: "POST",
              body: new URLSearchParams({ token, client_id: clientId }),
            })
          )
        );
        if (responses.some((result) => result.status === "rejected" || !result.value.ok)) {
          throw new Error(
            "AI Pass was disconnected locally. Remote revocation could not be confirmed."
          );
        }
      }),
    listModels,
    async complete({ model, system, user } = {}, signal) {
      if (
        typeof model !== "string" ||
        typeof system !== "string" ||
        typeof user !== "string" ||
        system.length + user.length > 100000
      ) {
        throw new Error("Invalid AI Pass cleanup request.");
      }
      if (!models || models.expiresAt <= now()) await listModels();
      if (!models.ids.has(model)) throw new Error("Select an available AI Pass model.");
      const { authorization, completion } = await serialize(async () => {
        signal?.throwIfAborted();
        const authorization = await accessToken();
        signal?.throwIfAborted();
        const completion = post(
          "/v1/chat/completions",
          {
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            stream: false,
            max_completion_tokens: 4096,
          },
          { Authorization: `Bearer ${authorization}`, "X-AIPass-OAuth-Client-Id": clientId },
          signal
        );
        return { authorization, completion };
      });
      const response = await completion;
      if (response.status === 401) {
        await serialize(() => {
          if (read()?.accessToken === authorization) store.clear();
        });
      }
      if (!response.ok) throw new Error(`AI Pass cleanup failed (HTTP ${response.status}).`);
      const { choices } = await response.json();
      const result = choices?.[0];
      if (result?.finish_reason !== "stop" || !result.message?.content?.trim?.()) {
        throw new Error("AI Pass returned an incomplete cleanup response.");
      }
      return result.message.content;
    },
  };
}

function registerAiPassCleanup({
  ipcMain,
  fetch,
  canUse,
  isSettingsWindow,
  canComplete,
  directory,
}) {
  const { runOAuthLoopbackFlow } = require("./oauthLoopbackFlow");
  const { safeStorage } = require("electron");
  const assertAvailable = () => {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
    ) {
      throw new Error("OpenWhispr needs a system keyring to store the AI Pass connection.");
    }
  };
  const store = createTokenStore(path.join(directory, "ai-pass-tokens.enc"), {
    encrypt(value) {
      assertAvailable();
      return safeStorage.encryptString(value);
    },
    decrypt: (value) => ({ value: safeStorage.decryptString(value) }),
  });
  store.assertAvailable = assertAvailable;
  const service = createAiPassCleanup({
    clientId: process.env.AIPASS_CLIENT_ID?.trim(),
    store,
    fetch,
    canUse: () => canUse(ORIGIN),
    runOAuth: runOAuthLoopbackFlow,
  });
  for (const method of ["status", "connect", "disconnect", "listModels"]) {
    ipcMain.handle(`aipass:${method}`, async (event) => {
      if (!isSettingsWindow(event)) throw new Error("AI Pass settings are unavailable here.");
      try {
        return { ok: true, data: await service[method]() };
      } catch {
        return { ok: false };
      }
    });
  }

  const requests = new Map();
  ipcMain.handle("aipass:complete", async (event, id, input) => {
    if (!canComplete(event) || typeof id !== "string" || requests.has(id)) {
      throw new Error("AI Pass cleanup is unavailable here.");
    }
    const controller = new AbortController();
    requests.set(id, controller);
    try {
      return { ok: true, data: await service.complete(input, controller.signal) };
    } catch {
      return { ok: false };
    } finally {
      requests.delete(id);
    }
  });
  ipcMain.on("aipass:cancel", (event, id) => {
    if (canComplete(event)) requests.get(id)?.abort();
  });
}

module.exports = { createAiPassCleanup, createTokenStore, registerAiPassCleanup };
