const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/emailDraftTarget.ts");

const PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const WORK_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";

const resolve = async (emailDraftTarget, gcalConnected, mcalAccounts, gmailStatus) => {
  const { resolveEmailDraftTarget } = await load();
  return resolveEmailDraftTarget({ emailDraftTarget, gcalConnected, mcalAccounts, gmailStatus });
};

test("an explicit choice always wins", async () => {
  assert.equal(await resolve("outlookWork", true, []), "outlookWork");
});

test("automatic follows the connected calendar", async () => {
  assert.equal(await resolve("auto", true, [{ email: "a@corp.com" }]), "gmail");
  assert.equal(await resolve("auto", false, [{ email: "a@corp.com" }]), "outlookWork");
  assert.equal(await resolve("auto", false, [{ email: "me@Outlook.com" }]), "outlookPersonal");
  assert.equal(await resolve("auto", false, []), "mailto");
});

test("an unknown stored value behaves like automatic", async () => {
  assert.equal(await resolve("yahoo", false, []), "mailto");
  const { normalizeEmailDraftTarget } = await load();
  assert.equal(normalizeEmailDraftTarget("yahoo"), "auto");
  assert.equal(normalizeEmailDraftTarget("gmail"), "gmail");
});

test("any work account picks outlook work, regardless of order", async () => {
  assert.equal(
    await resolve("auto", false, [{ email: "me@outlook.com" }, { email: "a@corp.com" }]),
    "outlookWork"
  );
  assert.equal(
    await resolve("auto", false, [{ email: "me@outlook.com" }, { email: "you@Hotmail.com" }]),
    "outlookPersonal"
  );
});

test("the tenant decides personal or work, whatever the address", async () => {
  // A personal account on a custom domain, and a work tenant on a consumer-looking domain.
  assert.equal(
    await resolve("auto", false, [{ email: "me@family.example", tenantId: PERSONAL_TENANT }]),
    "outlookPersonal"
  );
  assert.equal(
    await resolve("auto", false, [{ email: "a@live.ca", tenantId: WORK_TENANT }]),
    "outlookWork"
  );
  // An account connected before the tenant was stored falls back to the domain.
  assert.equal(
    await resolve("auto", false, [{ email: "me@family.example", tenantId: null }]),
    "outlookWork"
  );
});

test("personal Microsoft domains are recognised in every country", async () => {
  for (const email of [
    "me@hotmail.de",
    "me@outlook.fr",
    "me@live.co.uk",
    "me@hotmail.co.jp",
    "me@outlook.com.br",
    "me@windowslive.com",
    "me@passport.com",
  ]) {
    assert.equal(await resolve("auto", false, [{ email }]), "outlookPersonal", email);
  }
  // A company domain that merely starts with one of those words is still work.
  for (const email of ["a@live.nation.com", "a@outlookgroup.com", "a@hotmail-support.io"]) {
    assert.equal(await resolve("auto", false, [{ email }]), "outlookWork", email);
  }
});

const WORK = [{ email: "a@corp.com", tenantId: WORK_TENANT }];

test("with Gmail connected or needing a reconnect, Automatic and gmailSend send from chat", async () => {
  for (const setting of ["auto", "gmailSend"]) {
    for (const gmailStatus of ["connected", "reconnect_needed"]) {
      // Whatever calendar is connected: sending from chat wins over a compose link.
      assert.equal(await resolve(setting, true, WORK, gmailStatus), "gmailSend", setting);
      assert.equal(await resolve(setting, false, [], gmailStatus), "gmailSend", setting);
    }
  }
});

test("without Gmail, Automatic and a stored gmailSend both fall back to today's rules", async () => {
  for (const setting of ["auto", "gmailSend"]) {
    for (const gmailStatus of ["disconnected", undefined]) {
      assert.equal(await resolve(setting, true, [], gmailStatus), "gmail", setting);
      assert.equal(await resolve(setting, false, WORK, gmailStatus), "outlookWork", setting);
      assert.equal(await resolve(setting, false, [], gmailStatus), "mailto", setting);
    }
  }
});

test("an explicit compose choice keeps its compose window, whatever Gmail's state", async () => {
  for (const setting of ["gmail", "outlookWork", "outlookPersonal", "mailto"]) {
    for (const gmailStatus of ["connected", "reconnect_needed", "disconnected", undefined]) {
      assert.equal(
        await resolve(setting, true, WORK, gmailStatus),
        setting,
        `${setting}/${gmailStatus}`
      );
    }
  }
});

test("gmailSend is a setting of its own, never a compose target main can open", async () => {
  const { normalizeEmailDraftTarget, EMAIL_DRAFT_TARGET_SETTINGS } = await load();
  const { COMPOSE_TARGETS } = await import("../../src/helpers/connectors/emailCompose.js");
  assert.equal(normalizeEmailDraftTarget("gmailSend"), "gmailSend");
  assert.ok(EMAIL_DRAFT_TARGET_SETTINGS.includes("gmailSend"));
  assert.equal(COMPOSE_TARGETS.includes("gmailSend"), false);
});

test("the Gmail connector's status reads as connected, reconnect needed or disconnected", async () => {
  const { gmailSendStatus } = await load();
  const status = (overrides) => ({
    id: "gmail",
    connected: true,
    configured: true,
    accountLabel: "you@example.test",
    workspaceLabel: null,
    needsReconnect: false,
    ...overrides,
  });
  assert.equal(gmailSendStatus(undefined), "disconnected");
  assert.equal(gmailSendStatus(status({ connected: false })), "disconnected");
  // A status saying the build has no Google client never routes to Gmail.
  // (Gmail's getStatus reports configured: false only when there is no
  // login, so this is defensive.)
  assert.equal(gmailSendStatus(status({ configured: false })), "disconnected");
  assert.equal(gmailSendStatus(status()), "connected");
  assert.equal(gmailSendStatus(status({ needsReconnect: true })), "reconnect_needed");
  // A login that doesn't exist can't need reconnecting.
  assert.equal(gmailSendStatus(status({ connected: false, needsReconnect: true })), "disconnected");
});
