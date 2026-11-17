const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const { signEnvelope, verifyEnvelope } = require("../lib/envelope.cjs");
const keys = generateKeyPairSync("ed25519");
const trusted = {
  test: keys.publicKey.export({ type: "spki", format: "pem" }),
};

test("verify exact signed bytes and reject tampering, unknown keys and malformed envelopes", () => {
  const payload = { value: "catalog" };
  const signed = signEnvelope(
    Buffer.from(JSON.stringify(payload)),
    "test",
    keys.privateKey,
  );
  assert.deepEqual(verifyEnvelope(JSON.stringify(signed), trusted), payload);
  for (const bad of [
    {
      ...signed,
      payload: Buffer.from('{"value":"changed"}').toString("base64"),
    },
    { ...signed, keyId: "unknown" },
    { ...signed, algorithm: "none" },
    { ...signed, signature: "AAAA" },
    { ...signed, other: "not accepted" },
    { ...signed, payload: signed.payload + "!" },
  ])
    assert.throws(() => verifyEnvelope(JSON.stringify(bad), trusted));
  assert.throws(
    () => verifyEnvelope("x".repeat(2 * 1024 * 1024 + 1), trusted),
    /large/,
  );
});
