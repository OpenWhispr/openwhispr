// Parity with @titanium-labs/license-client: the SDK's shared golden vectors
// (copied from finedesignz/titanium-licensing packages/test-vectors/golden-vectors.json)
// must produce the same outcome with the desktop port.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const golden = require("../fixtures/titanium/golden-vectors.json");
const {
  parseAndVerifyLicenseKey,
  LicenseKeyError,
} = require("../../src/helpers/titanium/licenseKey");

const CODE_BY_OUTCOME = {
  expired: "expired",
  wrong_product: "audience_mismatch",
  tampered: "tampered",
};

const opts = { publicKey: golden.publicKeyHex, productId: golden.keygenProductId };

for (const vector of golden.vectors) {
  test(`[${vector.id}] ${vector.description}`, () => {
    if (vector.expectedOutcome === "valid") {
      assert.deepEqual(parseAndVerifyLicenseKey(vector.input, opts), vector.decodedPayload);
      return;
    }
    assert.throws(
      () => parseAndVerifyLicenseKey(vector.input, opts),
      (error) =>
        error instanceof LicenseKeyError && error.code === CODE_BY_OUTCOME[vector.expectedOutcome]
    );
  });
}

function mintKey(payload, privateKey) {
  const body = `key/${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const sig = crypto.sign(null, Buffer.from(body, "ascii"), privateKey).toString("base64url");
  return `${body}.${sig}`;
}

test("fails closed when the app has no product id or public key configured", () => {
  const valid = golden.vectors.find((v) => v.expectedOutcome === "valid");
  assert.throws(
    () => parseAndVerifyLicenseKey(valid.input, { publicKey: golden.publicKeyHex, productId: "" }),
    (e) => e.code === "unconfigured"
  );
  assert.throws(
    () => parseAndVerifyLicenseKey(valid.input, { publicKey: "", productId: "p" }),
    (e) => e.code === "unconfigured"
  );
});

test("a key signed by another Ed25519 key is tampered even with a matching payload", () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const key = mintKey(
    {
      product: { id: golden.keygenProductId },
      license: { id: "l1", expiry: null },
    },
    privateKey
  );
  assert.throws(
    () => parseAndVerifyLicenseKey(key, opts),
    (e) => e.code === "tampered"
  );
});

test("expiry is checked against the injected clock (boundary is expired)", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const key = mintKey(
    { product: { id: "p" }, license: { id: "l", expiry: "2027-01-01T00:00:00.000Z" } },
    privateKey
  );
  const at = (iso) => () => Date.parse(iso);
  const base = { publicKey: raw, productId: "p" };
  assert.equal(
    parseAndVerifyLicenseKey(key, { ...base, now: at("2026-12-31T23:59:59Z") }).license.id,
    "l"
  );
  assert.throws(
    () => parseAndVerifyLicenseKey(key, { ...base, now: at("2027-01-01T00:00:00Z") }),
    (e) => e.code === "expired"
  );
});

test("the shipped fork config names a Keygen product, so licenses can verify", () => {
  const { TITANIUM } = require("../../src/config/fork.config.json");
  assert.match(
    TITANIUM.keygenProductId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "an empty product id makes every license fail as unconfigured"
  );
});
