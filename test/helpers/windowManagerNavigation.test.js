const test = require("node:test");
const assert = require("node:assert/strict");

const { isAllowedAppNavigation } = require("../../src/helpers/navigationGuard.js");

test("navigation guard rejects arbitrary file URLs in a packaged app", () => {
  assert.equal(isAllowedAppNavigation("file:///etc/passwd", null), false);
  assert.equal(isAllowedAppNavigation("file:///Users/test/secret.txt", null), false);
});

test("navigation guard keeps the development app route and devtools available", () => {
  const appUrl = "http://localhost:5183/?panel=true";
  assert.equal(isAllowedAppNavigation("http://localhost:5183/", appUrl), true);
  assert.equal(isAllowedAppNavigation("http://localhost:5183/other", appUrl), false);
  assert.equal(isAllowedAppNavigation("devtools://devtools/bundled/inspector.html", null), true);
});
