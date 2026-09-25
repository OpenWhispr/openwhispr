const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/emailDraftTarget.ts");

const PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const WORK_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";

const resolve = async (emailDraftTarget, gcalConnected, mcalAccounts) => {
  const { resolveEmailDraftTarget } = await load();
  return resolveEmailDraftTarget({ emailDraftTarget, gcalConnected, mcalAccounts });
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
