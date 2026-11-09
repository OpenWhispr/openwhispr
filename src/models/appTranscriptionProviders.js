// Speech-to-text providers the app ships before a model registry publication lists them.
// The app keeps only the providers its bundled catalog has, so these join that catalog
// here. Once the catalog is synced from a publication that lists one, remove it below.
const APP_TRANSCRIPTION_PROVIDERS = [
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-transcribe",
    models: [
      {
        id: "openai/gpt-transcribe",
        name: "GPT Transcribe",
        description: "OpenAI's current transcription model",
        descriptionKey: "models.descriptions.transcription.openrouter_openai_gpt_transcribe",
      },
      {
        id: "deepgram/nova-3",
        name: "Nova-3",
        description: "Deepgram's fast multilingual transcription",
        descriptionKey: "models.descriptions.transcription.openrouter_deepgram_nova_3",
      },
      {
        id: "google/chirp-3",
        name: "Chirp 3",
        description: "Google's speech-to-text in 100+ languages",
        descriptionKey: "models.descriptions.transcription.openrouter_google_chirp_3",
      },
      {
        id: "mistralai/voxtral-mini-transcribe",
        name: "Voxtral Mini Transcribe",
        description: "Low-cost multilingual transcription",
        descriptionKey:
          "models.descriptions.transcription.openrouter_mistralai_voxtral_mini_transcribe",
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
