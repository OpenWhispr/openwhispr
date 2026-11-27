const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { files, parseChecksums, installBundle } = require("../../src/helpers/qwen3AsrBundle");
const {
  getRequiredModelFiles,
  getModelRuntime,
  getModelType,
} = require("../../src/helpers/parakeetModelInfo");
const { acceptCatalog } = require("../../model-registry/lib/schema.cjs");
const catalog = require("../../src/models/modelRegistryData.json");
const seed = require("../../model-registry/test/seed.json");
const id = "oruk-fourier-2b";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = files.map((file) => hash(file) + "  " + file).join("\n") + "\n";
const { createDownloadSignal } = require("../../src/helpers/downloadUtils");

test("Fourier is offered on compatible builds as an opt-in local English model", () => {
  assert.equal(acceptCatalog(catalog, seed, "1.12.2").parakeetModels[id], undefined);
  const model = acceptCatalog(catalog, seed, "1.12.3").parakeetModels[id];
  assert.equal(model.organization.id, "oruk");
  assert.deepEqual(model.supportedLanguages, ["en"]);
  assert.ok(!model.recommended);
  assert.equal(getModelRuntime(id), "offline");
  assert.equal(getModelType(id), "qwen3-asr");
  assert.deepEqual(getRequiredModelFiles(id), files);
});

test("manifest rejects partial, duplicate and unrecognized paths", () => {
  for (const invalid of [
    manifest.replace("conv_frontend.onnx", "../outside"),
    manifest.replace("decoder.int8.onnx.data", "decoder.int8.onnx"),
    manifest.slice(manifest.indexOf("\n") + 1),
  ])
    assert.throws(() => parseChecksums(invalid));
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-fourier-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, id);
  const config = {
    url: catalog.parakeetModels[id].downloadUrl,
    sha256: hash(manifest),
    size: files.reduce((n, f) => n + Buffer.byteLength(f), 0),
  };
  const download = async (url, dest, options) => {
    const name = url.split("/sherpa-int8/")[1];
    const data = name === "SHA256SUMS" ? manifest : name;
    assert.equal(options.expectedSha256, hash(data));
    await fs.writeFile(dest, data);
    options.onProgress?.(Buffer.byteLength(data));
  };
  return { root, target, config, download };
}

test("publish a complete verified bundle and repair an interrupted prior install", async (t) => {
  const { root, target, config, download } = await fixture(t);
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "broken"), "old");
  const progress = [];
  await installBundle(config, target, {
    download,
    signal: createDownloadSignal().signal,
    onProgress: (n) => progress.push(n),
    beforePublish: () => {},
  });
  assert.equal(progress.at(-1), config.size);
  assert.deepEqual(await fs.readdir(root), [id]);
  for (const f of files) assert.equal(await fs.readFile(path.join(target, f), "utf8"), f);
  await assert.rejects(fs.access(path.join(target, "broken")));
});

test("corruption, cancellation and policy revocation never expose a partial candidate", async (t) => {
  for (const reason of ["integrity", "cancel", "policy"]) {
    const { root, target, config, download } = await fixture(t);
    const ctl = createDownloadSignal();
    await assert.rejects(
      installBundle(config, target, {
        signal: ctl.signal,
        onProgress: () => {},
        download: async (...args) => {
          await download(...args);
          if (args[0].endsWith("conv_frontend.onnx")) {
            if (reason === "integrity") throw new Error("digest mismatch");
            if (reason === "cancel") ctl.abort();
          }
        },
        beforePublish: () => {
          if (reason === "policy") throw new Error("blocked by local model policy");
        },
      })
    );
    assert.deepEqual(await fs.readdir(root), []);
  }
});

test("only the Qwen decoder's leading control prefix is stripped before paste", () => {
  const { parseOfflineMessage } = require("../../src/helpers/parakeetWsResult");
  const raw = "language English<asr_text>It's quite a routine.";
  for (const msg of [raw, JSON.stringify({ text: raw }), "<asr_text> It's quite a routine."])
    assert.equal(parseOfflineMessage(msg, "qwen3-asr"), "It's quite a routine.");
  for (const prefix of ["**language English", "$LANG Ukrainian", "$LANGUAGE English"])
    assert.equal(parseOfflineMessage(prefix + "<asr_text>Hello.", "qwen3-asr"), "Hello.");
  assert.equal(parseOfflineMessage("<message", "qwen3-asr"), "");
  assert.equal(parseOfflineMessage("Say <message", "qwen3-asr"), "Say <message");
  assert.equal(parseOfflineMessage(raw, "transducer"), raw);
  for (const text of ["The language English is widely spoken.", "Print <asr_text> here."])
    assert.equal(parseOfflineMessage(text, "qwen3-asr"), text);
});
