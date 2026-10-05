const modelRegistryData = require("../models/modelRegistryData.json");
const { getModelType } = require("./parakeetModelInfo");

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

  const whisper = Object.keys(modelRegistryData.whisperModels).map((model) => ({
    provider: "whisper",
    model,
    downloaded: whisperManager.isModelDownloaded(model),
    default: isDefault("whisper", model),
  }));
  const sherpa = Object.keys(modelRegistryData.parakeetModels).map((model) => {
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
