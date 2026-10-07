const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/version.ts");

test("recognizes only canonical three-part app versions", async () => {
  const { isCanonicalAppVersion } = await load();

  for (const version of ["0.0.0", "1.8.1", "24.10.300"]) {
    assert.equal(isCanonicalAppVersion(version), true, version);
  }
  for (const version of ["1.8", "1.8.1.0", "01.8.1", "1.8.1-beta.1", "required", "1.x.1"]) {
    assert.equal(isCanonicalAppVersion(version), false, version);
  }
});

test("an invalid installed version never satisfies a valid minimum", async () => {
  const { compareAppVersions } = await load();

  assert.equal(compareAppVersions("required", "1.8.1"), -1);
  assert.equal(compareAppVersions("1.8.1-beta.1", "1.8.1"), -1);
  assert.equal(compareAppVersions("1.9.0", "1.8.1"), 1);
});

test("keeps renderer and main-process validation behavior aligned", async () => {
  const { isCanonicalAppVersion } = await load();
  const mainVersion = require("../../src/helpers/appVersion.js");
  const versions = [
    undefined,
    null,
    1,
    "",
    "0.0.0",
    "1.8.1",
    "24.10.300",
    "1.8",
    "1.8.1.0",
    "01.8.1",
    "1.8.1-beta.1",
    "required",
    "1.x.1",
  ];

  for (const version of versions) {
    assert.equal(
      isCanonicalAppVersion(version),
      mainVersion.isCanonicalAppVersion(version),
      String(version)
    );
  }
});

test("app version comparison uses strict numeric release parts", () => {
  const { compareAppVersions } = require("../../src/helpers/appVersion");
  assert.ok(compareAppVersions("1.10.0", "1.9.9") > 0);
  assert.equal(compareAppVersions("1.10.2", "1.10.2"), 0);
  assert.ok(compareAppVersions("1.9.9", "1.10.2") < 0);
  assert.ok(compareAppVersions("1.10.2-beta", "1.10.2") < 0);
});
