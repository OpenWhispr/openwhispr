const { renderOAuthResultPage } = require("./connectors/oauthResultPage");

// The page the loopback server shows after a calendar (Google, Microsoft)
// OAuth redirect. It answers the browser locally, so calendar connect does
// not depend on a hosted desktop-callback page (SITE_URL may be empty in a
// fork build). Copy is read at render time: the UI language may change while
// the browser is open.
function calendarResultPage({ i18n, render = renderOAuthResultPage }, ok) {
  const copy = (key) => i18n.t(`calendarConnect.browser.${key}`);
  return render({
    ok,
    title: copy(ok ? "connectedTitle" : "failedTitle"),
    body: copy(ok ? "connectedBody" : "failedBody"),
  });
}

// Lazy so tests and callers that inject their own i18n never load the
// translation bundles.
function defaultI18n() {
  return require("./i18nMain").i18nMain;
}

module.exports = { calendarResultPage, defaultI18n };
