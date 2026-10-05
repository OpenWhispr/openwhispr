const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  readWorkspacePolicyCache,
  writeWorkspacePolicyCache,
} = require("../../src/helpers/workspacePolicyCache");

const policyData = {
  managed: false,
  policy: null,
  policyUpdatedAt: null,
  endpointSupported: true,
};

function withTempCache(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-policy-cache-"));
  const cachePath = path.join(tempDir, "workspace-policy.json");
  try {
    run(cachePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("keys policy verdicts by API origin and the credential actually used", () => {
  withTempCache((cachePath) => {
    const identity = {
      apiOrigin: "https://api.openwhispr.test",
      credentialHash: "credential-a",
      accountId: "account-a",
    };
    writeWorkspacePolicyCache(cachePath, identity, policyData);

    assert.deepEqual(readWorkspacePolicyCache(cachePath, identity), policyData);
    assert.equal(
      readWorkspacePolicyCache(cachePath, { ...identity, credentialHash: "credential-b" }),
      null
    );
    assert.equal(
      readWorkspacePolicyCache(cachePath, {
        ...identity,
        apiOrigin: "https://self-hosted.openwhispr.test",
      }),
      null
    );
    assert.deepEqual(
      readWorkspacePolicyCache(cachePath, { ...identity, accountId: "account-b" }),
      policyData
    );
  });
});

test("preserves cached verdicts for multiple credentials and origins", () => {
  withTempCache((cachePath) => {
    const first = {
      apiOrigin: "https://api.openwhispr.test",
      credentialHash: "credential-a",
      accountId: "account-a",
    };
    const second = {
      apiOrigin: "https://self-hosted.openwhispr.test",
      credentialHash: "credential-b",
      accountId: "account-b",
    };
    writeWorkspacePolicyCache(cachePath, first, policyData);
    writeWorkspacePolicyCache(cachePath, second, {
      ...policyData,
      endpointSupported: false,
    });

    assert.equal(readWorkspacePolicyCache(cachePath, first)?.endpointSupported, true);
    assert.equal(readWorkspacePolicyCache(cachePath, second)?.endpointSupported, false);
  });
});

test("ignores legacy account-only and malformed cache envelopes", () => {
  withTempCache((cachePath) => {
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ accountId: "account-a", data: policyData }),
      "utf8"
    );
    const identity = {
      apiOrigin: "https://api.openwhispr.test",
      credentialHash: "credential-a",
      accountId: "account-a",
    };
    assert.equal(readWorkspacePolicyCache(cachePath, identity), null);

    fs.writeFileSync(cachePath, JSON.stringify({ version: 2, entries: "invalid" }), "utf8");
    assert.equal(readWorkspacePolicyCache(cachePath, identity), null);
  });
});
