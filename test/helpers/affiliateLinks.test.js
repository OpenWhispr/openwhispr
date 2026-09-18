const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
let directory;
let state = { token: null, generation: 0 };
let accountId = null;
const original = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => directory }, net: {} };
  if (parent?.filename.endsWith("affiliateLinks.js") && request === "./tokenStore")
    return { getState: () => state };
  if (parent?.filename.endsWith("affiliateLinks.js") && request === "./accountScopeBinding")
    return {
      read: () => null,
      resolveActiveAccountScope: () => (accountId ? { accountId } : null),
      hashToken: (value) => crypto.createHash("sha256").update(value).digest("hex"),
    };
  return original.call(this, request, parent, isMain);
};
const links = require("../../src/helpers/affiliateLinks");
Module._load = original;
const domain = "open-whispr-affiliate-sandbox.dub.link";
const link = `https://${domain}/creator`;
const arrival = `openwhispr://affiliate?link=${encodeURIComponent(link)}`;
test.beforeEach((t) => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "affiliate-links-"));
  state = { token: null, generation: 0 };
  accountId = null;
  process.env.OPENWHISPR_AFFILIATE_ENABLED = "true";
  process.env.OPENWHISPR_AFFILIATE_DOMAIN = domain;
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
});
test("only exact configured creator and protocol hosts are accepted", () => {
  assert.ok(links.parseArrival(arrival, "openwhispr", domain));
  for (const value of [
    link.replace(domain, `${domain}.evil.test`),
    link.replace("https:", "http:"),
    `https://user@${domain}/creator`,
    `https://${domain}/creator/more`,
  ])
    assert.equal(links.parseLink(value, domain), null);
  for (const value of [
    arrival.replace("affiliate?", "auth?"),
    arrival.replace("affiliate?", "user@affiliate?"),
    arrival.replace("openwhispr:", "other:"),
  ])
    assert.equal(links.parseArrival(value, "openwhispr", domain), null);
});
test("an install candidate binds once to signup and does not follow an account switch", () => {
  assert.equal(links.capture(arrival, "openwhispr"), true);
  state = { token: "a", generation: 1 };
  accountId = "a";
  assert.equal(links.candidateForCurrentAccount().link, link);
  state = { token: "b", generation: 2 };
  accountId = "b";
  assert.equal(links.candidateForCurrentAccount(), null);
  assert.equal(fs.existsSync(path.join(directory, "affiliate-candidate.json")), false);
});
test("a candidate captured under an unresolved credential cannot bind to another login", () => {
  state = { token: "a", generation: 1 };
  links.capture(arrival, "openwhispr");
  state = { token: "b", generation: 2 };
  accountId = "b";
  assert.equal(links.candidateForCurrentAccount(), null);
});
test("partial edits persist, stale writes fail, and a saved creator cannot be replaced", () => {
  state = { token: "a", generation: 1 };
  accountId = "a";
  links.saveCandidate({ link: "https://partial", generation: 1 });
  assert.equal(links.candidateForCurrentAccount().link, "https://partial");
  assert.throws(() => links.saveCandidate({ link, generation: 0 }), /AUTH_CONTEXT_CHANGED/);
  links.saveCandidate({ link, clickId: "click", saved: true, generation: 1 });
  links.saveCandidate({ link: `https://${domain}/other`, generation: 1 });
  links.capture(`openwhispr://affiliate?dub_id=second`, "openwhispr");
  assert.equal(links.candidateForCurrentAccount().clickId, "click");
});
test("resolution reads one redirect and never follows its target", async () => {
  state = { token: "a", generation: 1 };
  accountId = "a";
  let calls = 0;
  const result = await links.resolveLink(link, 1, async (url, options) => {
    calls++;
    assert.equal(url, link);
    assert.equal(options.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { location: "https://openwhispr.com/?dub_id=click" },
    });
  });
  assert.equal(calls, 1);
  assert.equal(result.clickId, "click");
  await assert.rejects(
    links.resolveLink(
      link,
      1,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/?dub_id=click" },
        })
    ),
    /REFERRAL_UNAVAILABLE/
  );
});
test("a credential change during resolution discards the click", async () => {
  state = { token: "a", generation: 1 };
  accountId = "a";
  await assert.rejects(
    links.resolveLink(link, 1, async () => {
      state = { token: "b", generation: 2 };
      return new Response(null, {
        status: 302,
        headers: { location: "https://openwhispr.com/?dub_id=click" },
      });
    }),
    /REFERRAL_UNAVAILABLE/
  );
});
