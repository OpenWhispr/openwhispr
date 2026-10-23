const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const {
  createEnterpriseAudioCredentials,
} = require("../../src/helpers/enterpriseAudioCredentials");
const { importEnterpriseAudioBootstrap } = require("../../src/helpers/enterpriseAudioBootstrap");
const { parseEnterpriseAudioDeepLink } = require("../../src/helpers/enterpriseAudioDeepLink");

function encryption() {
  const key = crypto.randomBytes(32);
  return {
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const result = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), result]);
    },
    decrypt(blob) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(12, 28));
      return {
        value: Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString(
          "utf8"
        ),
      };
    },
  };
}

function defaultVault(directory, { platform = "linux", backend, available = true }) {
  const cipher = encryption();
  let encryptions = 0;
  const electron = {
    app: { getPath: () => directory },
    safeStorage: {
      getSelectedStorageBackend: () => backend,
      isEncryptionAvailable: () => available,
      encryptString: (value) => {
        encryptions++;
        return cipher.encrypt(value);
      },
      decryptString: (value) => cipher.decrypt(value).value,
    },
  };
  const modules = new Map();
  const load = (filename) => {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const nativeRequire = createRequire(filename);
    vm.runInNewContext(
      readFileSync(filename, "utf8"),
      {
        module,
        Buffer,
        process: { platform },
        require: (name) => {
          if (name === "electron") return electron;
          if (name === "@napi-rs/keyring") throw new Error("OS keyring unavailable");
          if (name === "./debugLogger") return { warn() {}, info() {} };
          if (name === "./secretCrypto") return load(nativeRequire.resolve(name));
          return nativeRequire(name);
        },
      },
      { filename }
    );
    return module.exports;
  };
  return {
    vault: load(
      require.resolve("../../src/helpers/enterpriseAudioCredentials")
    ).createEnterpriseAudioCredentials({ directory }),
    encryptions: () => encryptions,
  };
}

test("the production vault rejects Linux basic_text before provisioning or importing plaintext", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ow-audio-default-secrets-"));
  const source = path.join(directory, "enterprise-audio-bootstrap.json");
  const fixture = defaultVault(path.join(directory, "encrypted"), { backend: "basic_text" });
  try {
    await assert.rejects(fixture.vault.save("account-a", "workspace-a", "http", "device-key"), {
      message: "OS-protected enterprise credential storage is unavailable",
    });
    await fs.writeFile(
      source,
      JSON.stringify({
        version: 1,
        accountId: "account-a",
        workspaceId: "workspace-a",
        credentials: { http: "device-key" },
      }),
      { mode: 0o600 }
    );
    await assert.rejects(
      importEnterpriseAudioBootstrap({
        directory,
        accountId: "account-a",
        workspaceId: "workspace-a",
        allowedSlots: ["http"],
        credentials: fixture.vault,
      }),
      { message: "OS-protected enterprise credential storage is unavailable" }
    );
    await fs.access(source);
    assert.equal(fixture.encryptions(), 0);
    assert.equal(fixture.vault.generation, 0);
    await assert.rejects(fs.access(path.join(directory, "encrypted")));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the production vault uses protected OS fallback storage and fails when none is available", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ow-audio-default-secrets-"));
  try {
    for (const [platform, backend] of [
      ["linux", "gnome_libsecret"],
      ["darwin", undefined],
      ["win32", undefined],
    ]) {
      const encryptedDirectory = path.join(directory, platform);
      const fixture = defaultVault(encryptedDirectory, { platform, backend });
      await fixture.vault.save("account-a", "workspace-a", "http", "device-key");
      assert.equal(await fixture.vault.read("account-a", "workspace-a", "http"), "device-key");
      assert.equal(fixture.encryptions(), 1);
      const files = await fs.readdir(encryptedDirectory);
      assert.equal(
        (await fs.readFile(path.join(encryptedDirectory, files[0]))).includes(
          Buffer.from("device-key")
        ),
        false
      );
    }
    const unavailable = defaultVault(path.join(directory, "unavailable"), {
      backend: "gnome_libsecret",
      available: false,
    });
    await assert.rejects(unavailable.vault.save("account-a", "workspace-a", "http", "key"), {
      message: "no encryption backend available",
    });
    assert.equal(unavailable.encryptions(), 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("encrypted enterprise credentials are atomic, isolated by account/workspace and invalidate on rotation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ow-audio-secrets-"));
  let changed = 0;
  const vault = createEnterpriseAudioCredentials({
    directory,
    crypto: encryption(),
    onChanged: () => changed++,
  });
  try {
    await Promise.all([
      vault.save("account-a", "workspace-a", "http", "test-http-secret"),
      vault.save("account-a", "workspace-a", "realtime", "test-ws-secret"),
    ]);
    assert.equal(await vault.read("account-a", "workspace-a", "http"), "test-http-secret");
    assert.equal(await vault.read("account-a", "workspace-a", "realtime"), "test-ws-secret");
    await assert.rejects(vault.read("account-b", "workspace-a", "http"), {
      code: "CREDENTIAL_MISSING",
    });
    await assert.rejects(vault.read("account-a", "workspace-b", "http"), {
      code: "CREDENTIAL_MISSING",
    });
    const files = await fs.readdir(directory);
    assert.equal(files.length, 1);
    assert.equal(
      (await fs.readFile(path.join(directory, files[0]))).includes(Buffer.from("test-http-secret")),
      false
    );
    await vault.saveMany("account-a", "workspace-a", { http: "rotated", realtime: "rotated-ws" });
    assert.equal(await vault.read("account-a", "workspace-a", "http"), "rotated");
    await assert.rejects(
      vault.saveMany("account-a", "workspace-a", {
        http: "should-not-save",
        realtime: "invalid\nsecret",
      })
    );
    assert.equal(await vault.read("account-a", "workspace-a", "http"), "rotated");
    await vault.remove("account-a", "workspace-a", "http");
    assert.equal((await vault.status("account-a", "workspace-a", "http")).present, false);
    assert.equal(changed, 4);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("protected MDM imports bind the signed-in account and configured slots and remove plaintext only after success", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ow-audio-bootstrap-"));
  const source = path.join(directory, "enterprise-audio-bootstrap.json");
  const vault = createEnterpriseAudioCredentials({
    directory: path.join(directory, "encrypted"),
    crypto: encryption(),
  });
  const input = {
    directory,
    accountId: "account-a",
    workspaceId: "workspace-a",
    allowedSlots: ["http", "realtime"],
    credentials: vault,
  };
  const deliver = (data) => fs.writeFile(source, JSON.stringify(data), { mode: 0o600 });
  try {
    const data = {
      version: 1,
      accountId: "account-a",
      workspaceId: "workspace-a",
      credentials: { http: "http-test", realtime: "ws-test" },
    };
    await deliver({ ...data, workspaceId: "workspace-b" });
    await assert.rejects(importEnterpriseAudioBootstrap(input));
    await fs.access(source);
    assert.equal((await vault.status("account-a", "workspace-a", "http")).present, false);
    await deliver({ ...data, credentials: { unapproved: "key" } });
    await assert.rejects(importEnterpriseAudioBootstrap(input));
    await deliver(data);
    assert.equal((await importEnterpriseAudioBootstrap(input)).imported, true);
    await assert.rejects(fs.access(source));
    assert.equal(await vault.read("account-a", "workspace-a", "realtime"), "ws-test");
    assert.equal((await importEnterpriseAudioBootstrap(input)).imported, false);
    if (process.platform !== "win32") {
      await deliver(data);
      await fs.chmod(source, 0o644);
      await assert.rejects(importEnterpriseAudioBootstrap(input));
      await fs.rm(source);
      await fs.symlink(path.join(directory, "encrypted"), source);
      await assert.rejects(importEnterpriseAudioBootstrap(input));
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("enterprise audio deep links carry references only and never credentials or arbitrary endpoints", () => {
  const url =
    "openwhispr://enterprise-audio-test?workspaceId=11111111-2222-4333-8444-555555555555&provider=openai-compatible";
  assert.deepEqual(parseEnterpriseAudioDeepLink(url), {
    workspaceId: "11111111-2222-4333-8444-555555555555",
    provider: "openai-compatible",
  });
  for (const invalid of [
    url + "&key=secret",
    url + "&endpoint=https://evil.test",
    url + "&provider=azure",
    url + "#secret",
    url.replace("openwhispr:", "https:"),
    url.replace("openai-compatible", "bedrock"),
  ])
    assert.equal(parseEnterpriseAudioDeepLink(invalid), null);
});
