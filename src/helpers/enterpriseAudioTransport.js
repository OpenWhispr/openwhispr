const https = require("node:https");
const tls = require("node:tls");
const { Agent } = require("agent-base");
const { HttpsProxyAgent } = require("https-proxy-agent");
const WebSocket = require("ws");
const { runAbortableOperation } = require("./enterpriseProviderErrors");

let systemRoots;
function trustedRoots(extraPem) {
  systemRoots ??= [
    ...new Set([
      ...(tls.getCACertificates?.("default") ?? tls.rootCertificates),
      ...(tls.getCACertificates?.("system") ?? []),
    ]),
  ];
  return extraPem ? [...systemRoots, extraPem] : systemRoots;
}

function proxyCandidates(value, mandatory = false) {
  const candidates = value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry === "DIRECT") return null;
      const match = /^(PROXY|HTTPS)\s+([^\s/]+)$/i.exec(entry);
      if (!match)
        throw Object.assign(new Error("Unsupported enterprise proxy type"), {
          code: "PROXY_UNSUPPORTED",
        });
      return `${match[1].toUpperCase() === "HTTPS" ? "https" : "http"}://${match[2]}`;
    });
  const permitted = mandatory ? candidates.filter(Boolean) : candidates;
  if (!permitted.length)
    throw Object.assign(new Error("The required enterprise proxy is unavailable"), {
      code: "PROXY_FAILED",
    });
  return permitted;
}

function bypassesProxy(url, rules = []) {
  const host = url.hostname.toLowerCase();
  return rules.some((rule) => {
    if (rule === "<local>") return !host.includes(".");
    const pattern = rule
      .toLowerCase()
      .replace(/[.+?^$()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return (
      new RegExp(`^${pattern}$`).test(host) ||
      new RegExp(`^${pattern}$`).test(url.host.toLowerCase())
    );
  });
}

function createEnterpriseAudioTransport({
  resolveProxy,
  readCredential,
  WebSocketClass = WebSocket,
}) {
  async function connectionOptions(
    endpoint,
    network = {},
    caPem,
    signal,
    credentialReader = readCredential
  ) {
    const url = new URL(endpoint);
    if (!["https:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error("Enterprise audio requires a secure endpoint without embedded credentials");
    const ca = trustedRoots(caPem);
    const proxy = network.proxy ?? { mode: "system" };
    let candidates;
    if (proxy.mode === "direct" || (!proxy.mandatory && bypassesProxy(url, proxy.bypass)))
      candidates = [null];
    else if (proxy.mode === "fixed") candidates = [proxy.url];
    else {
      const proxyUrl = new URL(url);
      proxyUrl.protocol = "https:";
      candidates = proxyCandidates(
        await runAbortableOperation(() => resolveProxy(proxyUrl.href), signal),
        proxy.mandatory
      );
    }
    const proxyHeaders = {};
    if (proxy.credentialSlot) {
      const secret = JSON.parse(
        await runAbortableOperation(() => credentialReader(proxy.credentialSlot), signal)
      );
      if (
        typeof secret.username !== "string" ||
        typeof secret.password !== "string" ||
        /[:\r\n]/.test(secret.username)
      )
        throw new Error("Invalid proxy credentials");
      proxyHeaders["Proxy-Authorization"] =
        `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString("base64")}`;
    }
    signal?.throwIfAborted();
    const agent = new Agent();
    agent.connect = async (req, options) => {
      let lastError;
      for (const candidate of candidates) {
        const attempt = new AbortController();
        try {
          if (!candidate)
            return new https.Agent().createConnection({ ...options, ca, rejectUnauthorized: true });
          const proxyUrl = new URL(candidate);
          if (
            !["http:", "https:"].includes(proxyUrl.protocol) ||
            proxyUrl.username ||
            proxyUrl.password
          )
            throw new Error("Invalid enterprise proxy origin");
          const candidateSignal = AbortSignal.any([attempt.signal, signal].filter(Boolean));
          const proxyAgent = new HttpsProxyAgent(proxyUrl, {
            ca,
            headers: proxyHeaders,
            signal: candidateSignal,
            rejectUnauthorized: true,
          });
          proxyAgent.once("proxyConnect", ({ statusCode }) => {
            // Reject before the agent installs its failed-CONNECT replay on req.
            if (statusCode !== 200)
              throw Object.assign(new Error(`Enterprise proxy CONNECT failed (${statusCode})`), {
                code: "PROXY_FAILED",
              });
          });
          return await proxyAgent.connect(req, {
            ...options,
            ca,
            signal: candidateSignal,
            rejectUnauthorized: true,
          });
        } catch (error) {
          attempt.abort(error);
          signal?.throwIfAborted();
          lastError = error;
        }
      }
      throw Object.assign(new Error("Enterprise proxy connection failed", { cause: lastError }), {
        code: "PROXY_FAILED",
      });
    };
    return { agent, ca, rejectUnauthorized: true };
  }

  async function request(
    endpoint,
    { network, caPem, signal, readCredential: credentialReader, ...init } = {}
  ) {
    const deadline = AbortSignal.any([
      AbortSignal.timeout(network?.httpTimeoutMs ?? 600000),
      ...(signal ? [signal] : []),
    ]);
    deadline.throwIfAborted();
    const dial = new AbortController();
    const connectTimer = setTimeout(
      () =>
        dial.abort(
          Object.assign(new Error("Enterprise connection timed out"), { code: "TIMEOUT" })
        ),
      network?.connectTimeoutMs ?? 15000
    );
    const connectionSignal = AbortSignal.any([deadline, dial.signal]);
    let connection;
    try {
      connection = await connectionOptions(
        endpoint,
        network,
        caPem,
        connectionSignal,
        credentialReader
      );
      const prepared = new Request(endpoint, { ...init, signal: deadline });
      const body = prepared.body ? Buffer.from(await prepared.arrayBuffer()) : null;
      deadline.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const req = https.request(
          endpoint,
          {
            ...connection,
            method: prepared.method,
            headers: Object.fromEntries(prepared.headers),
            signal: connectionSignal,
          },
          (res) => {
            const chunks = [];
            let bytes = 0;
            res.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > 8 * 1024 * 1024) {
                req.destroy(new Error("Enterprise response exceeded 8 MiB"));
                return;
              }
              chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () => {
              try {
                resolve(
                  new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), {
                    status: res.statusCode,
                    headers: res.headers,
                  })
                );
              } catch (error) {
                reject(error);
              }
            });
          }
        );
        req.on("socket", (socket) =>
          socket.once("secureConnect", () => clearTimeout(connectTimer))
        );
        req.on("close", () => clearTimeout(connectTimer));
        req.on("error", reject);
        req.end(body);
      });
    } finally {
      clearTimeout(connectTimer);
      dial.abort();
      connection?.agent.destroy();
    }
  }

  async function createSocket(
    endpoint,
    { network, caPem, headers, signal, readCredential: credentialReader } = {}
  ) {
    signal?.throwIfAborted();
    const dial = new AbortController();
    const connectionSignal = AbortSignal.any([dial.signal, ...(signal ? [signal] : [])]);
    const connectTimer = setTimeout(
      () =>
        dial.abort(
          Object.assign(new Error("Enterprise connection timed out"), { code: "TIMEOUT" })
        ),
      network?.connectTimeoutMs ?? 15000
    );
    let connection;
    let socket;
    try {
      connection = await connectionOptions(
        endpoint,
        network,
        caPem,
        connectionSignal,
        credentialReader
      );
      connectionSignal.throwIfAborted();
      socket = new WebSocketClass(endpoint, {
        ...connection,
        headers,
        handshakeTimeout: network?.connectTimeoutMs ?? 15000,
        followRedirects: false,
        maxPayload: 8 * 1024 * 1024,
      });
    } catch (error) {
      clearTimeout(connectTimer);
      dial.abort();
      connection?.agent.destroy();
      throw error;
    }
    socket.once("open", () => clearTimeout(connectTimer));
    // Revalidation may await identity work before the consumer installs listeners.
    socket.on("error", () => {});
    const abort = () => socket.terminate();
    connectionSignal.addEventListener("abort", abort, { once: true });
    socket.once("close", () => {
      clearTimeout(connectTimer);
      connectionSignal.removeEventListener("abort", abort);
      dial.abort();
      connection.agent.destroy();
    });
    return socket;
  }
  return { request, createSocket };
}

module.exports = { createEnterpriseAudioTransport, proxyCandidates, bypassesProxy, trustedRoots };
