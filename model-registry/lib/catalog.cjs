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

// A maintainer's capability-change label approves the commits it was added to, so it counts
// only in the run that adding it starts. A push, a reopened pull request or any other label
// change runs without it, until a maintainer removes the label and adds it again. Anyone who
// can write may label, so the author's own label, or a workflow's, approves nothing.
const capabilityChangeApproved = (event) =>
  event.action === "labeled" &&
  event.label?.name === "capability-change" &&
  event.sender?.type === "User" &&
  event.sender.login !== event.pull_request?.user?.login;

module.exports = { ...schema, readCatalog, capabilityChangeApproved };
