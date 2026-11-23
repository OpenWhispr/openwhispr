const crypto = require("node:crypto");
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

function signEnvelope(payload, keyId, privateKey) {
  return {
    algorithm: "Ed25519",
    keyId,
    payload: payload.toString("base64"),
    signature: crypto.sign(null, payload, privateKey).toString("base64"),
  };
}

function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("Invalid registry encoding");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value)
    throw new Error("Non-canonical registry encoding");
  return decoded;
}

function verifyEnvelope(bytes, trustedKeys) {
  if (Buffer.byteLength(bytes) > MAX_ENVELOPE_BYTES)
    throw new Error("Registry envelope too large");
  const envelope = JSON.parse(bytes.toString());
  if (
    !envelope ||
    Object.keys(envelope).sort().join(",") !==
      "algorithm,keyId,payload,signature" ||
    envelope.algorithm !== "Ed25519" ||
    typeof envelope.keyId !== "string" ||
    !Object.hasOwn(trustedKeys, envelope.keyId)
  )
    throw new Error("Untrusted registry envelope");
  const payload = decodeBase64(envelope.payload);
  const signature = decodeBase64(envelope.signature);
  const key = crypto.createPublicKey(trustedKeys[envelope.keyId]);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    signature.length !== 64 ||
    !crypto.verify(null, payload, key, signature)
  )
    throw new Error("Invalid registry signature");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
}
module.exports = { signEnvelope, verifyEnvelope, MAX_ENVELOPE_BYTES };
