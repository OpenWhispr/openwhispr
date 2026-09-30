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

test("a connector's result page is worded from its own browser copy, at render time", async () => {
  const { connectorResultPage } =
    await import("../../../src/helpers/connectors/oauthResultPage.js");
  const pages = [];
  let language = "en";
  const render = connectorResultPage(
    {
      i18n: { t: (key) => `${language}:${key}` },
      renderOAuthResultPage: (page) => {
        pages.push(page);
        return "<html>";
      },
    },
    "linear"
  );

  language = "de";
  assert.equal(render({ ok: true }), "<html>");
  render({ ok: false });

  assert.deepEqual(pages, [
    {
      ok: true,
      title: "de:connectors.linear.browser.connectedTitle",
      body: "de:connectors.linear.browser.connectedBody",
    },
    {
      ok: false,
      title: "de:connectors.linear.browser.failedTitle",
      body: "de:connectors.linear.browser.failedBody",
    },
  ]);
});
