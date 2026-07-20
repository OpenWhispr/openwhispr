const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/navigationPolicy.js");

test("production navigation to the app's own file:// content is internal", async () => {
  const { isInternalNavigation } = await load();

  // appUrl is null in production (loadFile() is used, not loadURL()).
  assert.equal(
    isInternalNavigation("file:///Applications/OpenWhispr.app/Contents/Resources/app.asar/src/dist/index.html", null),
    true
  );
});

test("devtools navigation is always internal", async () => {
  const { isInternalNavigation } = await load();

  assert.equal(isInternalNavigation("devtools://devtools/bundled/inspector.html", null), true);
  assert.equal(
    isInternalNavigation("devtools://devtools/bundled/inspector.html", "http://localhost:5183/?panel=true"),
    true
  );
});

test("an external link in production is not internal", async () => {
  const { isInternalNavigation } = await load();

  // Regression guard: appUrl is null in production, and this must not throw —
  // a throw here used to skip event.preventDefault() entirely, letting the
  // control panel window navigate straight to the external page with no way
  // back (e.g. the changelog link in Settings -> System -> Software Updates).
  assert.equal(isInternalNavigation("https://github.com/OpenWhispr/openwhispr/releases", null), false);
});

test("dev server navigation matches the control panel's own URL", async () => {
  const { isInternalNavigation } = await load();

  const appUrl = "http://localhost:5183/?panel=true";
  assert.equal(isInternalNavigation(appUrl, appUrl), true);
  assert.equal(isInternalNavigation("https://github.com/OpenWhispr/openwhispr/releases", appUrl), false);
});
