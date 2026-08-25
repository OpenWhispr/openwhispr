const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isAllowedAppNavigation,
  isExternalBrowserUrl,
} = require("../../src/helpers/navigationGuard.js");

const PACKAGED_APP_URL =
  "file:///Applications/OpenWhispr.app/Contents/Resources/app.asar/src/dist/index.html";

test("packaged app: the window's own reload is allowed regardless of query or hash", () => {
  // location.reload() fires will-navigate with the window's own URL —
  // sign-out, restart-onboarding, account deletion, and the ErrorBoundary
  // reload all break if this is blocked.
  assert.equal(isAllowedAppNavigation(`${PACKAGED_APP_URL}?panel=true`, PACKAGED_APP_URL), true);
  assert.equal(isAllowedAppNavigation(PACKAGED_APP_URL, PACKAGED_APP_URL), true);
  assert.equal(
    isAllowedAppNavigation(`${PACKAGED_APP_URL}?panel=true#settings`, PACKAGED_APP_URL),
    true
  );
});

test("packaged app: Windows-style file URLs compare on the encoded pathname", () => {
  const winAppUrl = "file:///C:/Program%20Files/OpenWhispr/resources/app.asar/src/dist/index.html";
  assert.equal(isAllowedAppNavigation(`${winAppUrl}?panel=true`, winAppUrl), true);
});

test("packaged app: foreign file URLs are blocked", () => {
  assert.equal(isAllowedAppNavigation("file:///etc/passwd", PACKAGED_APP_URL), false);
  assert.equal(isAllowedAppNavigation("file:///Users/test/secret.txt", PACKAGED_APP_URL), false);
});

test("packaged app: remote and unparseable URLs are blocked", () => {
  assert.equal(isAllowedAppNavigation("https://example.com/", PACKAGED_APP_URL), false);
  assert.equal(isAllowedAppNavigation("http://localhost:5183/", PACKAGED_APP_URL), false);
  assert.equal(isAllowedAppNavigation("not a url", PACKAGED_APP_URL), false);
});

test("a null appUrl blocks everything except devtools without throwing", () => {
  assert.equal(isAllowedAppNavigation("file:///etc/passwd", null), false);
  assert.equal(isAllowedAppNavigation("https://example.com/", undefined), false);
  assert.equal(isAllowedAppNavigation("devtools://devtools/bundled/inspector.html", null), true);
});

test("navigation guard keeps the development app route and devtools available", () => {
  const appUrl = "http://localhost:5183/?panel=true";
  assert.equal(isAllowedAppNavigation("http://localhost:5183/", appUrl), true);
  assert.equal(isAllowedAppNavigation("http://localhost:5183/?panel=true", appUrl), true);
  assert.equal(isAllowedAppNavigation("http://localhost:5183/other", appUrl), false);
  assert.equal(isAllowedAppNavigation("devtools://devtools/bundled/inspector.html", null), true);
});

test("only http(s) targets are handed to the external browser", () => {
  assert.equal(isExternalBrowserUrl("https://example.com/docs"), true);
  assert.equal(isExternalBrowserUrl("http://example.com/"), true);
  assert.equal(isExternalBrowserUrl("file:///etc/passwd"), false);
  assert.equal(isExternalBrowserUrl("about:blank"), false);
  assert.equal(isExternalBrowserUrl("devtools://devtools/bundled/inspector.html"), false);
});
