// Dev-only harness: proves one OAuth round trip with the REAL auth modules.
// Not packaged (electron-builder "files" lists no scripts/).
//
//   npx electron scripts/fork-oauth-e2e.js --provider google|microsoft|slack|linear \
//     --handoff <file> --userData <tmpdir>
//
// It loads .env through the app's EnvironmentManager, points userData at the
// temp dir, and replaces the browser-open step (in this process only) so the
// authorization URL is written to <handoff> instead of opening a browser. A
// portal executor completes consent in its own browser; the provider (via the
// relay for Slack and Linear) then redirects to this process's loopback server.
// On completion it writes { provider, ok, hasAccessToken, hasRefreshToken,
// expiresAt } to <handoff>.result.json. It never prints or writes a token value.
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const PROVIDERS = ["google", "microsoft", "slack", "linear"];

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function fail(code) {
  process.stderr.write(`fork-oauth-e2e: ${code}\n`);
  app.exit(1);
}

const provider = arg("provider");
const handoff = arg("handoff");
const userData = arg("userData");
if (!PROVIDERS.includes(provider) || !handoff || !userData) {
  process.stderr.write(
    "usage: electron scripts/fork-oauth-e2e.js --provider google|microsoft|slack|linear --handoff <file> --userData <dir>\n"
  );
  app.exit(2);
}

app.setPath("userData", path.resolve(userData));

// Replace the browser-open step for this process only. Must run before any
// module that requires the opener loads.
const openerPath = require.resolve("../src/helpers/externalUrlOpener");
require.cache[openerPath] = {
  id: openerPath,
  filename: openerPath,
  loaded: true,
  exports: {
    openExternalUrl: async (url) => {
      fs.writeFileSync(handoff, JSON.stringify({ provider, url }));
    },
  },
};

function summarize(tokens) {
  return {
    provider,
    ok: Boolean(tokens?.access_token || tokens?.accessToken),
    hasAccessToken: Boolean(tokens?.access_token || tokens?.accessToken),
    hasRefreshToken: Boolean(tokens?.refresh_token || tokens?.refreshToken),
    expiresAt: tokens?.expires_at ?? tokens?.expiresAt ?? null,
  };
}

async function runCalendar(kind) {
  const { i18nMain } = require("../src/helpers/i18nMain");
  const saved = {};
  const db = {
    saveGoogleTokens: (tokens) => (saved.tokens = tokens),
    saveMicrosoftTokens: (tokens) => (saved.tokens = tokens),
  };
  const OAuth =
    kind === "google"
      ? require("../src/helpers/googleCalendarOAuth")
      : require("../src/helpers/microsoftCalendarOAuth");
  await new OAuth(db, { i18n: i18nMain }).startOAuthFlow();
  return summarize(saved.tokens);
}

async function runConnector(kind) {
  const { runOAuthLoopbackFlow, OAuthFlowError } = require("../src/helpers/oauthLoopbackFlow");
  const { connectorResultPage } = require("../src/helpers/connectors/oauthResultPage");
  const { i18nMain } = require("../src/helpers/i18nMain");
  const renderResultPage = connectorResultPage({ i18n: i18nMain }, kind);
  const fetchImpl = (...args) => fetch(...args);
  const common = {
    credentials: {},
    runOAuthLoopbackFlow,
    OAuthFlowError,
    renderResultPage,
  };

  if (kind === "slack") {
    const { createSlackApi } = require("../src/helpers/connectors/slackApi");
    const { createSlackAuth } = require("../src/helpers/connectors/slackAuth");
    const auth = createSlackAuth({
      ...common,
      api: createSlackApi({ fetchImpl }),
      getClientId: () => process.env.SLACK_CLIENT_ID,
    });
    return summarize(await auth.authorize());
  }

  const { createLinearApi } = require("../src/helpers/connectors/linearApi");
  const { createLinearAuth, linearRedirectUri } = require("../src/helpers/connectors/linearAuth");
  const auth = createLinearAuth({
    ...common,
    api: createLinearApi({ fetchImpl }),
    getClientId: () => process.env.LINEAR_CLIENT_ID,
    redirectUri: linearRedirectUri(process.env),
  });
  return summarize(await auth.authorize());
}

app.whenReady().then(async () => {
  try {
    // Loads userData/.env and the packaged/dev .env into process.env.
    const EnvironmentManager = require("../src/helpers/environment");
    new (EnvironmentManager.default || EnvironmentManager)();

    const result =
      provider === "google" || provider === "microsoft"
        ? await runCalendar(provider)
        : await runConnector(provider);
    fs.writeFileSync(`${handoff}.result.json`, JSON.stringify(result));
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    // Code only: an error message could carry provider response text.
    fs.writeFileSync(
      `${handoff}.result.json`,
      JSON.stringify({ provider, ok: false, error: error?.code || error?.name || "error" })
    );
    fail(error?.code || error?.name || "error");
  }
});
