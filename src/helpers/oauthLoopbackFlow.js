const http = require("http");
const crypto = require("crypto");
const { openExternalUrl } = require("./externalUrlOpener");

const OAUTH_TIMEOUT_MS = 120000;
const DEFAULT_DESKTOP_CALLBACK_URL = "https://openwhispr.com/auth/desktop-callback";

const PROTOCOL_BY_CHANNEL = {
  development: "openwhispr-dev",
  staging: "openwhispr-staging",
  production: "openwhispr",
};

// Thrown by handleCallback to control the error code shown on the hosted
// desktop-callback page (defaults to "server_error").
class OAuthFlowError extends Error {
  constructor(redirectCode, message) {
    super(message);
    this.redirectCode = redirectCode;
  }
}

function getDesktopCallbackUrl() {
  return process.env.VITE_OPENWHISPR_OAUTH_CALLBACK_URL || DEFAULT_DESKTOP_CALLBACK_URL;
}

function getProtocol() {
  const channel = process.env.OPENWHISPR_CHANNEL || "production";
  return PROTOCOL_BY_CHANNEL[channel] || PROTOCOL_BY_CHANNEL.production;
}

function buildCallbackRedirect(params) {
  const url = new URL(getDesktopCallbackUrl());
  url.searchParams.set("protocol", getProtocol());
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function redirect(res, params) {
  res.writeHead(302, { Location: buildCallbackRedirect(params) });
  res.end();
}

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// Runs a PKCE auth-code flow through an ephemeral 127.0.0.1 server:
// - buildAuthUrl(redirectUri, state, codeChallenge) → provider authorize URL
// - handleCallback(code, redirectUri, codeVerifier) → resolves the flow result;
//   called once with a state-validated code, throws (OAuthFlowError for a
//   specific callback-page code) to reject.
// - errorParam — query-param name for the hosted desktop-callback page
//   (e.g. "gcal_error"); the success param is derived from the same prefix.
// - redirectHost / ports / callbackPath — shape redirect_uri for providers
//   that match it exactly (fixed ports are tried in order); the server
//   always listens on 127.0.0.1. With a callbackPath, only that path is a
//   callback.
// - renderResultPage({ ok }) — answer the browser from this server instead
//   of the hosted page, for providers that page doesn't know.
// - publicRedirectUri — for providers that require an HTTPS redirect: the
//   provider redirects to that URL (a relay), which forwards the browser to
//   this server by the port carried in state as v1.<port>.<nonce>. An error
//   callback then counts only with that state.
// - timeoutMs — how long the flow waits for the provider's redirect.
// - signal — an AbortSignal that gives the flow up (a newer attempt replaced
//   it): the server closes and the flow rejects with code "oauth_cancelled".
//   Once the provider has answered, the exchange finishes regardless, so a
//   login it already issued still reaches the caller.
function runOAuthLoopbackFlow({
  buildAuthUrl,
  handleCallback,
  errorParam,
  redirectHost = "127.0.0.1",
  ports = [0],
  callbackPath = "",
  renderResultPage = null,
  publicRedirectUri = null,
  timeoutMs = OAUTH_TIMEOUT_MS,
  signal = null,
}) {
  const connectedParam = errorParam.replace(/_error$/, "_connected");
  if (signal?.aborted) {
    return Promise.reject(codedError("oauth_cancelled", "OAuth flow cancelled"));
  }

  return new Promise((resolve, reject) => {
    const codeVerifier = crypto.randomBytes(32).toString("base64url").slice(0, 43);
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const nonce = crypto.randomBytes(32).toString("hex");
    // Behind a relay the provider never sees this server, so the relay finds it
    // by the port in state. It is set once listening, before the browser opens.
    let state = nonce;
    const redirectUriFor = (port) =>
      publicRedirectUri ?? `http://${redirectHost}:${port}${callbackPath}`;
    let callbackClaimed = false;

    const respond = (res, ok, params) => {
      if (renderResultPage) {
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderResultPage({ ok }));
        return;
      }
      redirect(res, params);
    };

    const invalidRequest = (res) => {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<html><body><h3>Invalid request.</h3></body></html>");
    };

    const server = http.createServer(async (req, res) => {
      // Accepted requests can outlive server.close(), so only the first
      // terminal callback may settle the flow or exchange a code.
      if (callbackClaimed) {
        invalidRequest(res);
        return;
      }

      try {
        const url = new URL(req.url, `http://127.0.0.1`);
        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        // With a callback path, nothing else on this port is the provider's
        // answer: a stray request is refused and the flow keeps waiting.
        if (callbackPath && url.pathname !== callbackPath) {
          invalidRequest(res);
          return;
        }

        // Behind a relay, an error counts only with this flow's state:
        // without it, it is a stray request, not the user's answer.
        if (error && publicRedirectUri && returnedState !== state) {
          invalidRequest(res);
          return;
        }

        if (error) {
          callbackClaimed = true;
          respond(res, false, { [errorParam]: error });
          cleanup();
          reject(codedError("oauth_denied", `OAuth error: ${error}`, { providerError: error }));
          return;
        }

        if (!code || returnedState !== state) {
          invalidRequest(res);
          // A real callback with a code but the wrong state is a failed
          // attempt (stale tab, CSRF). Fail the flow now. A request with no
          // code (favicon / bare GET) must keep waiting for the redirect.
          if (code) {
            callbackClaimed = true;
            cleanup();
            reject(codedError("oauth_state_mismatch", "OAuth state mismatch"));
          }
          return;
        }

        callbackClaimed = true;
        const result = await handleCallback(
          code,
          redirectUriFor(server.address().port),
          codeVerifier
        );

        respond(res, true, { [connectedParam]: "true" });
        cleanup();
        resolve(result);
      } catch (err) {
        callbackClaimed = true;
        respond(res, false, { [errorParam]: err.redirectCode || "server_error" });
        cleanup();
        reject(err);
      }
    });

    let timeoutId;
    let listenErrorHandler = null;

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      if (server.listening) server.close();
    };

    const onAbort = () => {
      if (callbackClaimed) return;
      callbackClaimed = true;
      cleanup();
      reject(codedError("oauth_cancelled", "OAuth flow cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // One "listening" handler for the whole flow: a failed attempt on a busy
    // port must not leave behind a second one that opens another tab.
    server.once("listening", () => {
      // Given up while binding: close without opening the browser.
      if (callbackClaimed) {
        server.close();
        return;
      }
      if (listenErrorHandler) server.off("error", listenErrorHandler);
      server.on("error", (err) => {
        cleanup();
        reject(err);
      });
      // Fire-and-forget like the shell.openExternal call it replaced: a
      // failed browser launch surfaces as the flow timeout.
      const port = server.address().port;
      if (publicRedirectUri) state = `v1.${port}.${nonce}`;
      openExternalUrl(buildAuthUrl(redirectUriFor(port), state, codeChallenge)).catch(() => {});
    });

    // A port in use falls through to the next one in the list.
    const listenOn = (index) => {
      listenErrorHandler = (err) => {
        listenErrorHandler = null;
        if (err.code === "EADDRINUSE" && index + 1 < ports.length) {
          listenOn(index + 1);
          return;
        }
        callbackClaimed = true;
        cleanup();
        reject(
          err.code === "EADDRINUSE" ? codedError("ports_busy", "No loopback port was free") : err
        );
      };
      server.once("error", listenErrorHandler);
      server.listen(ports[index], "127.0.0.1");
    };
    listenOn(0);

    timeoutId = setTimeout(() => {
      callbackClaimed = true;
      cleanup();
      reject(codedError("oauth_timeout", "OAuth flow timed out"));
    }, timeoutMs);
  });
}

module.exports = { runOAuthLoopbackFlow, OAuthFlowError };
