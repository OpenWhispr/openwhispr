const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);

// Shown in the browser tab after a connector's OAuth redirect. The loopback
// server serves it, so it works without openwhispr.com.
function renderOAuthResultPage({ ok, title, body }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f7f7f8;color:#1a1a1a}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#555}
@media (prefers-color-scheme:dark){body{background:#161618;color:#f2f2f2}p{color:#aaa}}
</style></head>
<body><main dir="auto" data-ok="${ok ? "true" : "false"}"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

// The page after one connector's OAuth redirect, worded from
// connectors.<id>.browser.* when it is shown (the language may change while
// the browser is open, so the copy is read at render time, not build time).
function connectorResultPage(
  { i18n, renderOAuthResultPage: render = renderOAuthResultPage },
  connectorId
) {
  const copy = (key) => i18n.t(`connectors.${connectorId}.browser.${key}`);
  return ({ ok }) =>
    render({
      ok,
      title: copy(ok ? "connectedTitle" : "failedTitle"),
      body: copy(ok ? "connectedBody" : "failedBody"),
    });
}

module.exports = { renderOAuthResultPage, connectorResultPage };
