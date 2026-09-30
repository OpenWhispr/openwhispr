// Every connector the app ships, built from one set of dependencies, so a new
// connector adds its module and one line here, and main.js doesn't change.
const { buildEmailConnector } = require("./emailConnector");
const { buildSlackConnector } = require("./slackConnector");
const { buildGmailConnector } = require("./gmailConnector");
const { buildLinearConnector } = require("./linearConnector");
const { buildGithubConnector } = require("./githubConnector");

const CONNECTOR_FACTORIES = [
  buildEmailConnector,
  buildSlackConnector,
  buildGmailConnector,
  buildLinearConnector,
  buildGithubConnector,
];

// Two connectors with one id would share login slots and receipts: a build
// fault, thrown at startup like the manager's editable-type check.
function assertUniqueIds(connectors) {
  const seen = new Set();
  for (const connector of connectors) {
    if (seen.has(connector.id)) throw new Error(`connector id "${connector.id}" is used twice`);
    seen.add(connector.id);
  }
}

/**
 * deps: { fetch, i18n, runOAuthLoopbackFlow, OAuthFlowError, credentials,
 * logger, env, openExternal, writeClipboard, getGoogleCalendarAccounts,
 * broadcast, notifyStatusChanged } (spec §9.3).
 */
function createConnectors(deps, factories = CONNECTOR_FACTORIES) {
  const connectors = factories.map((build) => build(deps));
  assertUniqueIds(connectors);
  return connectors;
}

module.exports = { createConnectors };
