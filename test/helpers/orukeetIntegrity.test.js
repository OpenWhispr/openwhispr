const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { verify } = require("../../src/helpers/orukeetModel");
const { getModelRuntime, getRequiredModelFiles } = require("../../src/helpers/parakeetModelInfo");

test("native model integrity rejects truncation and same-size corruption", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"orukeet-integrity-"));
  try {
    const file=path.join(dir,"model.gguf"), bytes=Buffer.from("verified model fixture");
    const info={expectedSizeBytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")};
    await fs.writeFile(file,bytes); await verify(file,info);
    await fs.writeFile(file,bytes.subarray(1)); await assert.rejects(verify(file,info),/size mismatch/);
    bytes[0]^=1; await fs.writeFile(file,bytes); await assert.rejects(verify(file,info),/checksum mismatch/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test("GGUF and ONNX model readiness use distinct formats", () => {
  assert.equal(getModelRuntime("orukeet-v0.1.0-q8"),"orukeet");
  assert.deepEqual(getRequiredModelFiles("orukeet-v0.1.0-q8"),["orukeet-r3-93ce19c6-q8.gguf"]);
  assert(getRequiredModelFiles("parakeet-tdt-0.6b-v3").includes("encoder.int8.onnx"));
  assert.equal(getModelRuntime("nemotron-speech-streaming-en-0.6b"),"online");
});
