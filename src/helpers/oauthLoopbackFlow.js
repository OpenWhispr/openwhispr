const http = require("http");
const crypto = require("crypto");
const { shell } = require("electron");

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

// Runs a PKCE auth-code flow through an ephemeral 127.0.0.1 server:
// - buildAuthUrl(redirectUri, state, codeChallenge) → provider authorize URL
// - handleCallback(code, redirectUri, codeVerifier) → resolves the flow result;
//   called once with a state-validated code, throws (OAuthFlowError for a
//   specific callback-page code) to reject.
// - errorParam — query-param name for the hosted desktop-callback page
//   (e.g. "gcal_error"); the success param is derived from the same prefix.
function runOAuthLoopbackFlow({ buildAuthUrl, handleCallback, errorParam }) {
  const connectedParam = errorParam.replace(/_error$/, "_connected");

  return new Promise((resolve, reject) => {
    const codeVerifier = crypto.randomBytes(32).toString("base64url").slice(0, 43);
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const state = crypto.randomBytes(32).toString("hex");

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1`);
        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          redirect(res, { [errorParam]: error });
          cleanup();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<html><body><h3>Invalid request.</h3></body></html>");
          return;
        }

        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const result = await handleCallback(code, redirectUri, codeVerifier);

        redirect(res, { [connectedParam]: "true" });
        cleanup();
        resolve(result);
      } catch (err) {
        redirect(res, { [errorParam]: err.redirectCode || "server_error" });
        cleanup();
        reject(err);
      }
    });

    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      server.close();
    };

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      shell.openExternal(buildAuthUrl(redirectUri, state, codeChallenge));
    });

    timeoutId = setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out"));
    }, OAUTH_TIMEOUT_MS);

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

module.exports = { runOAuthLoopbackFlow, OAuthFlowError };
