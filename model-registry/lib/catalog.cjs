const fs = require("node:fs");
const path = require("node:path");
const schema = require("./schema.cjs");

function readCatalog(root = path.join(__dirname, "..", "registry")) {
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(root, `${name}.json`), "utf8"));
  const legacy = read("legacy");
  return {
    parakeetModels: read("parakeet"),
    diarizationModels: legacy.diarizationModels,
    whisperModels: read("whisper"),
    transcriptionProviders: read("transcription-providers"),
    cloudProviders: read("cloud-providers"),
    enterpriseProviders: read("enterprise-providers"),
    localProviders: read("local-gguf"),
    openwhisprCloudModels: legacy.openwhisprCloudModels,
  };
}
module.exports = { ...schema, readCatalog };
