const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let connectorErrorCopyKey;

test.before(async () => {
  ({ connectorErrorCopyKey } = await import("../../src/utils/connectorErrorCopy.ts"));
});

const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
).connectors;

test("codes with their own copy map to themselves", () => {
  for (const code of [
    "not_in_channel",
    "channel_not_found",
    "is_archived",
    "reconnect_needed",
    "connection_changed",
    "rate_limited",
    "missing_scope",
    "msg_too_long",
    "no_text",
    "credential_save_failed",
    "open_failed",
    "draft_too_long",
    "invalid_address",
  ]) {
    assert.equal(connectorErrorCopyKey(code), code);
  }
});

test("a refused or revoked login reads as reconnect_needed, Slack's other spelling as rate_limited", () => {
  for (const code of ["invalid_auth", "account_inactive", "not_authed", "token_revoked"]) {
    assert.equal(connectorErrorCopyKey(code), "reconnect_needed", code);
  }
  assert.equal(connectorErrorCopyKey("ratelimited"), "rate_limited");
});

test("a request that never reached Slack, or a refresh Slack couldn't answer, reads as network", () => {
  for (const code of [
    "ENOTFOUND",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ECONNRESET",
    "ERR_INTERNET_DISCONNECTED",
    "UND_ERR_CONNECT_TIMEOUT",
    "network_error",
    "timeout",
    "http_500",
    "http_503",
    "internal_error",
    "service_unavailable",
  ]) {
    assert.equal(connectorErrorCopyKey(code), "network", code);
  }
});

test("a DM Slack wouldn't open reads as dm_failed", () => {
  for (const code of [
    "user_not_found",
    "user_not_visible",
    "user_disabled",
    "cannot_dm_bot",
    "not_enough_users",
    "too_many_users",
    "users_list_not_supplied",
    "method_not_supported_for_channel_type",
  ]) {
    assert.equal(connectorErrorCopyKey(code), "dm_failed", code);
  }
});

test("a read-only or restricted channel reads as restricted", () => {
  for (const code of [
    "restricted_action",
    "restricted_action_read_only_channel",
    "ekm_access_denied",
  ]) {
    assert.equal(connectorErrorCopyKey(code), "restricted", code);
  }
});

test("everything else, including a missing code, reads as generic", () => {
  for (const code of [
    "invalid_arguments",
    "http_400",
    "http_404",
    "bad_response",
    "action_failed",
    "clipboard_unreserved",
    "weird_code",
    "constructor",
    "__proto__",
    "",
    undefined,
    null,
  ]) {
    assert.equal(connectorErrorCopyKey(code), "generic", String(code));
  }
});

test("every key the card and the tool step can show has English copy", () => {
  const cardKeys = [
    "not_in_channel",
    "channel_not_found",
    "is_archived",
    "reconnect_needed",
    "connection_changed",
    "rate_limited",
    "missing_scope",
    "msg_too_long",
    "no_text",
    "credential_save_failed",
    "network",
    "dm_failed",
    "restricted",
    "generic",
  ];
  const emailOnlyKeys = ["open_failed", "draft_too_long", "invalid_address"];
  for (const key of cardKeys) {
    assert.equal(typeof en.approval.errors[key], "string", `approval.errors.${key}`);
  }
  for (const key of [...cardKeys, ...emailOnlyKeys]) {
    assert.equal(typeof en.toolStatus.errors[key], "string", `toolStatus.errors.${key}`);
  }
});
