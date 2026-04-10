const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  return crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

function publicKeyRawBase64Url(publicKeyPem) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

function resolveIdentityPath() {
  return path.join(app.getPath("userData"), "openclaw", "device-identity.json");
}

function loadOrCreateDeviceIdentity() {
  const filePath = resolveIdentityPath();
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {}
  const identity = generateIdentity();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        deviceId: identity.deviceId,
        publicKeyPem: identity.publicKeyPem,
        privateKeyPem: identity.privateKeyPem,
        createdAtMs: Date.now(),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return identity;
}

function normalizeForAuth(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function buildDeviceAuthPayloadV3(params) {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    normalizeForAuth(params.platform),
    normalizeForAuth(params.deviceFamily),
  ].join("|");
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

function buildDeviceAuthBlock({
  identity,
  clientId,
  clientMode,
  role,
  scopes,
  token,
  platform,
  deviceFamily,
  nonce,
  signedAtMs,
}) {
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes,
    signedAtMs,
    token,
    nonce,
    platform,
    deviceFamily,
  });
  const signature = signDevicePayload(identity.privateKeyPem, payload);
  return {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
    signature,
    signedAt: signedAtMs,
    nonce,
  };
}

module.exports = {
  loadOrCreateDeviceIdentity,
  buildDeviceAuthBlock,
};
