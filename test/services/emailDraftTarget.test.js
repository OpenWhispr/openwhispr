const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/emailDraftTarget.ts");
const loadCompose = () => import("../../src/helpers/connectors/emailCompose.js");

test("an explicit choice always wins", async () => {
  const { resolveEmailDraftTarget } = await load();
  assert.equal(
    resolveEmailDraftTarget("outlookWork", { gcalConnected: true, mcalAccountEmails: [] }),
    "outlookWork"
  );
});

test("automatic follows the connected calendar", async () => {
  const { resolveEmailDraftTarget } = await load();
  assert.equal(resolveEmailDraftTarget("auto", { gcalConnected: true, mcalAccountEmails: ["a@corp.com"] }), "gmail");
  assert.equal(resolveEmailDraftTarget("auto", { gcalConnected: false, mcalAccountEmails: ["a@corp.com"] }), "outlookWork");
  assert.equal(
    resolveEmailDraftTarget("auto", { gcalConnected: false, mcalAccountEmails: ["me@Outlook.com"] }),
    "outlookPersonal"
  );
  assert.equal(resolveEmailDraftTarget("auto", { gcalConnected: false, mcalAccountEmails: [] }), "mailto");
});

test("an unknown stored value behaves like automatic", async () => {
  const { resolveEmailDraftTarget } = await load();
  assert.equal(resolveEmailDraftTarget("yahoo", { gcalConnected: false, mcalAccountEmails: [] }), "mailto");
});

test("the renderer target list matches the main-process compose targets", async () => {
  const [{ EMAIL_DRAFT_TARGETS }, { COMPOSE_TARGETS }] = await Promise.all([load(), loadCompose()]);
  assert.deepEqual([...EMAIL_DRAFT_TARGETS], COMPOSE_TARGETS);
});

test("any work account picks outlook work, regardless of order", async () => {
  const { resolveEmailDraftTarget } = await load();
  // personal first, work second
  assert.equal(
    resolveEmailDraftTarget("auto", { gcalConnected: false, mcalAccountEmails: ["me@outlook.com", "a@corp.com"] }),
    "outlookWork"
  );
  // all personal
  assert.equal(
    resolveEmailDraftTarget("auto", { gcalConnected: false, mcalAccountEmails: ["me@outlook.com", "you@Hotmail.com"] }),
    "outlookPersonal"
  );
});
