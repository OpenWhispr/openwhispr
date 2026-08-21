const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const authenticationStepSource = fs.readFileSync(
  path.join(__dirname, "../../src/components/AuthenticationStep.tsx"),
  "utf8"
);

test("Apple sign-in is available on every desktop platform", () => {
  const providerList = authenticationStepSource.match(
    /const providers = \[([\s\S]*?)\n {2}\];/
  )?.[1];

  assert.ok(providerList, "authentication provider list exists");
  assert.match(
    providerList,
    /},\s*\{\s*id:\s*"apple",[\s\S]*?handleSocialSignIn\("apple"\)[\s\S]*?\},\s*\{\s*id:\s*"microsoft"/
  );
});
