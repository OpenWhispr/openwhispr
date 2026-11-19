const { registryData, listRunnableLocalModels } = require("../models/registryData.js");
const { getModelType } = require("./parakeetModelInfo");

// Every offered local model, plus a retired one still on disk, since a selection can keep
// running it.
function runnableModelIds(section, isDownloaded) {
  return listRunnableLocalModels(section)
    .map(([id]) => id)
    .filter((id) => Object.hasOwn(registryData[section], id) || isDownloaded(id));
}

// Every local speech-to-text model the registry knows, with whether it is on
// disk and whether it is the one the app is set to use. The "default" comes
// from the .env values the renderer persists for server pre-warming, which is
// the only copy of that setting the main process has.
function listLocalTranscriptionModels({ whisperManager, parakeetManager, env = process.env }) {
  const configuredProvider = env.LOCAL_TRANSCRIPTION_PROVIDER || "";
  const configuredModel =
    configuredProvider === "whisper" ? env.LOCAL_WHISPER_MODEL || "" : env.PARAKEET_MODEL || "";
  const isDefault = (provider, model) =>
    provider === configuredProvider && model === configuredModel;

  const whisper = runnableModelIds("whisperModels", (model) =>
    whisperManager.isModelDownloaded(model)
  ).map((model) => ({
    provider: "whisper",
    model,
    downloaded: whisperManager.isModelDownloaded(model),
    default: isDefault("whisper", model),
  }));
  const sherpa = runnableModelIds("parakeetModels", (model) =>
    parakeetManager.isModelDownloaded(model)
  ).map((model) => {
    const provider = getModelType(model) === "cohere-transcribe" ? "cohere" : "nvidia";
    return {
      provider,
      model,
      downloaded: parakeetManager.isModelDownloaded(model),
      default: isDefault(provider, model),
    };
  });
  return [...whisper, ...sherpa];
}

module.exports = { listLocalTranscriptionModels };
