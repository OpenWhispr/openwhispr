const test = require("node:test");
const assert = require("node:assert/strict");

test("the browser result page escapes its text and marks the outcome", async () => {
  const { renderOAuthResultPage } =
    await import("../../../src/helpers/connectors/oauthResultPage.js");

  const html = renderOAuthResultPage({
    ok: true,
    title: "Slack is <b>connected</b>",
    body: "Close & return",
  });

  assert.match(html, /Slack is &lt;b&gt;connected&lt;\/b&gt;/);
  assert.match(html, /Close &amp; return/);
  assert.match(html, /data-ok="true"/);
  assert.match(renderOAuthResultPage({ ok: false, title: "x", body: "y" }), /data-ok="false"/);
});
