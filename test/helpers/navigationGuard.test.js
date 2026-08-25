const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

const load = () => import("../../src/helpers/navigationGuard.js");

const PACKAGED_APP_URL =
  "file:///Applications/OpenWhispr.app/Contents/Resources/app.asar/src/dist/index.html";
const DEV_APP_URL = "http://localhost:5183/?panel=true";

test("packaged self-reload is allowed regardless of query string", async () => {
  const { isAllowedAppNavigation } = await load();

  // location.reload() fires will-navigate with the window's own file:// URL,
  // including the ?panel=true query loadFile() attached.
  assert.equal(isAllowedAppNavigation(`${PACKAGED_APP_URL}?panel=true`, PACKAGED_APP_URL), true);
  assert.equal(isAllowedAppNavigation(PACKAGED_APP_URL, PACKAGED_APP_URL), true);
  assert.equal(isAllowedAppNavigation(`${PACKAGED_APP_URL}?onboarding=1`, PACKAGED_APP_URL), true);
});

test("packaged self-reload is allowed on Windows-shaped file URLs", async () => {
  const { isAllowedAppNavigation } = await load();

  const windowsAppUrl =
    "file:///C:/Users/Jane%20Doe/AppData/Local/OpenWhispr/app.asar/src/dist/index.html";
  assert.equal(isAllowedAppNavigation(`${windowsAppUrl}?panel=true`, windowsAppUrl), true);
});

test("foreign file:// URLs are blocked in packaged builds", async () => {
  const { isAllowedAppNavigation } = await load();

  assert.equal(isAllowedAppNavigation("file:///etc/passwd", PACKAGED_APP_URL), false);
  assert.equal(isAllowedAppNavigation("file:///Users/test/secret.txt", PACKAGED_APP_URL), false);
  assert.equal(
    isAllowedAppNavigation(
      "file:///Applications/OpenWhispr.app/Contents/Resources/app.asar/package.json",
      PACKAGED_APP_URL
    ),
    false
  );
});

test("remote URLs are blocked in packaged builds", async () => {
  const { isAllowedAppNavigation } = await load();

  assert.equal(isAllowedAppNavigation("https://evil.example/", PACKAGED_APP_URL), false);
  assert.equal(isAllowedAppNavigation("http://localhost:5183/", PACKAGED_APP_URL), false);
});

test("a null app URL blocks navigation without throwing", async () => {
  const { isAllowedAppNavigation } = await load();

  assert.equal(isAllowedAppNavigation(`${PACKAGED_APP_URL}?panel=true`, null), false);
  assert.equal(isAllowedAppNavigation("https://evil.example/", null), false);
});

test("malformed candidate URLs are blocked without throwing", async () => {
  const { isAllowedAppNavigation } = await load();

  assert.equal(isAllowedAppNavigation("not a url", PACKAGED_APP_URL), false);
  assert.equal(isAllowedAppNavigation("", PACKAGED_APP_URL), false);
});

test("devtools URLs are always allowed", async () => {
  const { isAllowedAppNavigation } = await load();

  assert.equal(
    isAllowedAppNavigation("devtools://devtools/bundled/inspector.html", PACKAGED_APP_URL),
    true
  );
  assert.equal(isAllowedAppNavigation("devtools://devtools/bundled/inspector.html", null), true);
});

test("dev mode keeps the origin+pathname match against the dev server", async () => {
  const { isAllowedAppNavigation } = await load();

  assert.equal(isAllowedAppNavigation("http://localhost:5183/?panel=true", DEV_APP_URL), true);
  assert.equal(isAllowedAppNavigation("http://localhost:5183/", DEV_APP_URL), true);
  assert.equal(isAllowedAppNavigation("http://localhost:5183/other", DEV_APP_URL), false);
  assert.equal(isAllowedAppNavigation("http://localhost:9999/", DEV_APP_URL), false);
  assert.equal(isAllowedAppNavigation("https://localhost:5183/", DEV_APP_URL), false);
  assert.equal(isAllowedAppNavigation("https://example.com/", DEV_APP_URL), false);
});

test("resolveAppNavigationUrl prefers the dev server URL", async () => {
  const { resolveAppNavigationUrl } = await load();

  assert.equal(
    resolveAppNavigationUrl({ devServerUrl: DEV_APP_URL, appFilePath: null }),
    DEV_APP_URL
  );
});

test("resolveAppNavigationUrl converts the packaged index.html path to a file URL", async () => {
  const { resolveAppNavigationUrl } = await load();

  const appFilePath =
    "/Applications/OpenWhispr.app/Contents/Resources/app.asar/src/dist/index.html";
  assert.equal(
    resolveAppNavigationUrl({ devServerUrl: null, appFilePath }),
    pathToFileURL(appFilePath).href
  );
});

test("resolveAppNavigationUrl returns null when neither source is available", async () => {
  const { resolveAppNavigationUrl } = await load();

  assert.equal(resolveAppNavigationUrl({ devServerUrl: null, appFilePath: null }), null);
});

test("resolved packaged URL admits a Chromium-encoded reload of a path with spaces", async () => {
  const { isAllowedAppNavigation, resolveAppNavigationUrl } = await load();

  const appFilePath = "/Users/Jane Doe/apps/OpenWhispr/app.asar/src/dist/index.html";
  const appUrl = resolveAppNavigationUrl({ devServerUrl: null, appFilePath });
  const reloadUrl =
    "file:///Users/Jane%20Doe/apps/OpenWhispr/app.asar/src/dist/index.html?panel=true";

  assert.equal(isAllowedAppNavigation(reloadUrl, appUrl), true);
  assert.equal(isAllowedAppNavigation("file:///Users/Jane%20Doe/other.html", appUrl), false);
});

test("resolved packaged URL admits a reload from a non-ASCII install path", async () => {
  const { isAllowedAppNavigation, resolveAppNavigationUrl } = await load();

  // Chromium reports file URLs with UTF-8 percent-encoding; pathToFileURL must
  // produce the same canonical form or self-reload breaks on such installs.
  const appFilePath = "/Users/José/apps/OpenWhispr/app.asar/src/dist/index.html";
  const appUrl = resolveAppNavigationUrl({ devServerUrl: null, appFilePath });
  const reloadUrl =
    "file:///Users/Jos%C3%A9/apps/OpenWhispr/app.asar/src/dist/index.html?panel=true";

  assert.equal(isAllowedAppNavigation(reloadUrl, appUrl), true);
});
