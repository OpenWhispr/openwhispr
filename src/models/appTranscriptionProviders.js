// Speech-to-text providers the app ships before model-registry/ lists them. The app keeps
// only the providers its bundled catalog has, so these join that catalog here. Once
// model-registry/ lists one, remove it below.
const APP_TRANSCRIPTION_PROVIDERS = [
  {
    id: "sarvam",
    name: "Sarvam AI",
    baseUrl: "https://api.sarvam.ai",
    defaultModel: "saaras:v4",
    models: [
      {
        id: "saaras:v4",
        name: "Saaras v4",
        streaming: true,
        description: "22 Indian languages, global English and dictionary hints",
        descriptionKey: "models.descriptions.transcription.sarvam_v4",
      },
      {
        id: "saaras:v3",
        name: "Saaras v3",
        streaming: true,
        description: "22 Indian languages and Indian English",
        descriptionKey: "models.descriptions.transcription.sarvam_v3",
      },
    ],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    baseUrl: "https://api.elevenlabs.io/v1",
    defaultModel: "scribe_v3",
    // Dictation sends this, and the Upload screen labels it, in place of a realtime or
    // unlisted selection. Upload and Retry requests go through resolveByokModel instead,
    // so its ElevenLabs fallback must change with this.
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

// ElevenLabs realtime models stream only in Note Recording and have no batch endpoint:
// dictation, onboarding and Audio Upload never offer them, and a batch request for one
// takes the provider default. The catalog has no field for this, so the rule goes by the
// id, which also holds for a model a publication lists.
export function isNoteRecordingOnlyTranscriptionModel(providerId, modelId) {
  return providerId === "elevenlabs" && /_(realtime|live)$/.test(modelId);
}

/**
 * The models of one provider that a context lists. Shared by the pickers' lists and the
 * settings store so neither keeps a model the other hides.
 *
 * @template {{ id: string, streaming?: boolean }} Model
 * @param {string} providerId
 * @param {readonly Model[]} models
 * @param {import("../stores/policyRules").TranscriptionPolicyContext} context
 * @returns {Model[]}
 */
export function transcriptionModelsForContext(providerId, models, context) {
  if (context === "meeting") return models.filter((model) => model.streaming);
  const batchModels = models.filter(
    (model) => !isNoteRecordingOnlyTranscriptionModel(providerId, model.id)
  );
  if (context === "dictation")
    return batchModels.filter((model) => !isUploadOnlyTranscriptionModel(providerId, model.id));
  return batchModels;
}
