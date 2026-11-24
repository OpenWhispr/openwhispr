// Speech-to-text providers the app ships before model-registry/ lists them. The app keeps
// only the providers its bundled catalog has, so these join that catalog here. Once
// model-registry/ lists one, remove it below.
const APP_TRANSCRIPTION_PROVIDERS = [
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    baseUrl: "https://api.elevenlabs.io/v1",
    defaultModel: "scribe_v3",
    // Upload and Retry use this in place of the Note Recording-only realtime model.
    batchModel: "scribe_v3",
    models: [
      {
        id: "scribe_v3",
        name: "Scribe v3",
        description: "Most accurate multilingual transcription",
        descriptionKey: "models.descriptions.transcription.elevenlabs_scribe_v3",
      },
      {
        id: "scribe_v2",
        name: "Scribe v2",
        description: "Accurate multilingual transcription",
        descriptionKey: "models.descriptions.transcription.elevenlabs_scribe_v2",
      },
      {
        id: "scribe_v3_live",
        name: "Scribe v3 Live",
        description: "Live transcription for note recording",
        descriptionKey: "models.descriptions.transcription.elevenlabs_scribe_v3_live",
        streaming: true,
      },
    ],
  },
];

// Models only Audio Upload offers. The catalog has no field for this, so it lives here,
// by provider. OpenRouter forwards no dictionary to Deepgram, and dictation relies on it.
// Adding a model users may already have saved for dictation also needs a saved-selection
// migration, since Retry sends the stored id as-is.
const UPLOAD_ONLY_MODELS = new Map([["openrouter", ["deepgram/nova-3"]]]);

// Models that stream only in Note Recording, which have no batch endpoint: dictation,
// onboarding and Audio Upload never offer them. Kept here for the same reason, so the
// rule holds once a publication lists the model.
const NOTE_RECORDING_ONLY_MODELS = new Map([["elevenlabs", ["scribe_v3_live"]]]);

export function withAppTranscriptionProviders(catalog) {
  const listed = new Set(catalog.transcriptionProviders.map((provider) => provider.id));
  return {
    ...catalog,
    transcriptionProviders: [
      ...catalog.transcriptionProviders,
      ...structuredClone(
        APP_TRANSCRIPTION_PROVIDERS.filter((provider) => !listed.has(provider.id))
      ),
    ],
  };
}

export function isUploadOnlyTranscriptionModel(providerId, modelId) {
  return UPLOAD_ONLY_MODELS.get(providerId)?.includes(modelId) ?? false;
}

export function isNoteRecordingOnlyTranscriptionModel(providerId, modelId) {
  return NOTE_RECORDING_ONLY_MODELS.get(providerId)?.includes(modelId) ?? false;
}
