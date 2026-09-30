const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const LOCALES = ["ar", "de", "en", "es", "fr", "it", "ja", "pt", "ru", "zh-CN", "zh-TW"];
// Foundation spec §5.5: the codes whose shared copy is worded for Slack.
const SHARED_SIX = [
  "reconnect_needed",
  "network",
  "rate_limited",
  "connection_changed",
  "credential_save_failed",
  "generic",
];
// Settings row failures a Linear connect or disconnect can report
// (ConnectorLoginRow's ROW_ERRORS that Linear produces, and its fallback).
const ROW_ERRORS = [
  "connect_failed",
  "disconnect_failed",
  "oauth_denied",
  "oauth_timeout",
  "oauth_state_mismatch",
  "ports_busy",
  "token_exchange_failed",
  "not_configured",
  "connection_changed",
  "signed_out",
  "policy_blocked",
  "policy_unavailable",
  "permission_not_granted",
];

const connectorsIn = (locale) =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, `../../src/locales/${locale}/translation.json`), "utf8")
  ).connectors;

let connectorErrorText;
let i18n;
let LINEAR_ERROR_CODES;

test.before(async () => {
  const [copy, i18nModule, connector] = await Promise.all([
    import("../../src/utils/connectorErrorCopy.ts"),
    import("../../src/i18n.ts"),
    import("../../src/helpers/connectors/linearConnector.js"),
  ]);
  ({ connectorErrorText } = copy);
  i18n = i18nModule.default.default ?? i18nModule.default;
  ({ LINEAR_ERROR_CODES } = connector);
});

test("every code the Linear connector returns has Linear's own card and tool-step copy, in every locale", () => {
  const codes = [...LINEAR_ERROR_CODES, "generic"];
  assert.ok(LINEAR_ERROR_CODES.length >= 17, "the connector's list is the source of truth");
  for (const locale of LOCALES) {
    const connectors = connectorsIn(locale);
    for (const scope of ["approval", "toolStatus"]) {
      const own = connectors[scope].errors.linear;
      assert.ok(own, `${locale}: connectors.${scope}.errors.linear`);
      for (const code of codes) {
        const text = own[code];
        assert.equal(typeof text, "string", `${locale}: ${scope}.errors.linear.${code}`);
        assert.match(text, /Linear/, `${locale}: ${scope}.errors.linear.${code} names Linear`);
        assert.doesNotMatch(text, /Slack/, `${locale}: ${scope}.errors.linear.${code}`);
      }
      assert.deepEqual(
        Object.keys(own).sort(),
        [...codes].sort(),
        `${locale}: ${scope}.errors.linear has exactly the connector's codes`
      );
    }
  }
});

test("none of the six shared codes falls back to Slack's wording for Linear (foundation §5.5)", () => {
  for (const locale of LOCALES) {
    const t = i18n.getFixedT(locale);
    for (const scope of ["approval", "toolStatus"]) {
      for (const code of SHARED_SIX) {
        const shown = connectorErrorText(t, scope, "linear", code);
        assert.notEqual(
          shown,
          t(`connectors.${scope}.errors.${code}`),
          `${locale} ${scope} ${code}`
        );
        assert.equal(
          shown,
          t(`connectors.${scope}.errors.linear.${code}`),
          `${locale} ${scope} ${code}`
        );
      }
      // A raw transport code and a code with no copy of its own still read as Linear's.
      assert.equal(
        connectorErrorText(t, scope, "linear", "ENOTFOUND"),
        t(`connectors.${scope}.errors.linear.network`),
        `${locale} ${scope} ENOTFOUND`
      );
      assert.equal(
        connectorErrorText(t, scope, "linear", "query_failed"),
        t(`connectors.${scope}.errors.linear.generic`),
        `${locale} ${scope} query_failed`
      );
    }
  }
});

test("the Linear row, browser page, card note, link and receipts have copy in every locale", () => {
  for (const locale of LOCALES) {
    const connectors = connectorsIn(locale);
    const linear = connectors.linear;
    const strings = [
      ...["title", "description", "connect", "reconnect", "disconnect", "connecting"].map((key) => [
        key,
        linear[key],
      ]),
      ["connectedAs", linear.connectedAs],
      ["needsReconnect", linear.needsReconnect],
      ["proRequired", linear.proRequired],
      ...ROW_ERRORS.map((code) => [`errors.${code}`, linear.errors[code]]),
      ...["connectedTitle", "connectedBody", "failedTitle", "failedBody"].map((key) => [
        `browser.${key}`,
        linear.browser[key],
      ]),
      // Each priority the card can show, and "you" as the assignee, in the
      // locale's own words (no English value interpolated into the note).
      ...["urgent", "high", "medium", "low", "none"].map((name) => [
        `notes.priority.${name}`,
        linear.notes.priority[name],
      ]),
      ["notes.assignedToYou", linear.notes.assignedToYou],
      ["approval.openIn.linear", connectors.approval.openIn.linear],
      ["toolStatus.unknownSent.linear", connectors.toolStatus.unknownSent.linear],
      ["recent.actions.linear_create_issue", connectors.recent.actions.linear_create_issue],
      ["recent.actions.linear_comment", connectors.recent.actions.linear_comment],
      [
        "recent.unlabeledActions.linear_create_issue",
        connectors.recent.unlabeledActions.linear_create_issue,
      ],
      ["recent.unlabeledActions.linear_comment", connectors.recent.unlabeledActions.linear_comment],
    ];
    for (const [key, text] of strings) {
      assert.equal(typeof text, "string", `${locale}: ${key}`);
      assert.doesNotMatch(text, /Slack|Gmail/, `${locale}: ${key}`);
    }
    assert.match(
      linear.connectedAs,
      /\{\{account\}\}.*\{\{workspace\}\}|\{\{workspace\}\}.*\{\{account\}\}/
    );
    assert.match(connectors.toolStatus.unknownSent.linear, /\{\{destination\}\}/);
    for (const note of [...Object.values(linear.notes.priority), linear.notes.assignedToYou]) {
      assert.doesNotMatch(note, /\{\{/, `${locale}: a note with nothing left to fill in`);
    }
    assert.equal(linear.title, "Linear");
  }
});

test("the Linear copy sits at the foundation's anchors, right after Gmail's", () => {
  for (const locale of LOCALES) {
    const connectors = connectorsIn(locale);
    const after = (object, anchor, key) => {
      const keys = Object.keys(object);
      assert.equal(
        keys.indexOf(key),
        keys.indexOf(anchor) + 1,
        `${locale}: ${key} after ${anchor}`
      );
    };
    after(connectors, "gmail", "linear");
    after(connectors.approval.errors, "gmail", "linear");
    after(connectors.toolStatus.errors, "gmail", "linear");
    after(connectors.approval.openIn, "gmail", "linear");
    after(connectors.toolStatus.unknownSent, "gmail", "linear");
    after(connectors.recent.actions, "gmail_send", "linear_create_issue");
    after(connectors.recent.actions, "linear_create_issue", "linear_comment");
    after(connectors.recent.unlabeledActions, "gmail_send", "linear_create_issue");
    after(connectors.recent.unlabeledActions, "linear_create_issue", "linear_comment");
  }
});

test("each Linear tool has a tool-step name and working line in every locale, right after Slack's", () => {
  const tools = ["linear_search_issues", "linear_create_issue", "linear_comment"];
  for (const locale of LOCALES) {
    const copy = JSON.parse(
      fs.readFileSync(path.join(__dirname, `../../src/locales/${locale}/translation.json`), "utf8")
    ).agentMode.tools;
    const keys = Object.keys(copy);
    for (const suffix of ["Name", "Status"]) {
      const expected = [`slack_send_message${suffix}`, ...tools.map((tool) => `${tool}${suffix}`)];
      const start = keys.indexOf(expected[0]);
      assert.deepEqual(
        keys.slice(start, start + expected.length),
        expected,
        `${locale}: agentMode.tools ${suffix}`
      );
      for (const key of expected.slice(1)) {
        assert.match(copy[key], /Linear/, `${locale}: agentMode.tools.${key} names Linear`);
      }
    }
  }
});
