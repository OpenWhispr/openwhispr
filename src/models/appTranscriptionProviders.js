// Speech-to-text providers the app ships before a model registry publication lists them.
// The app keeps only the providers its bundled catalog has, so these join that catalog
// here. Once the catalog is synced from a publication that lists one, remove it below.
const APP_TRANSCRIPTION_PROVIDERS = [
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "mistralai/voxtral-mini-transcribe-3-0",
    models: [
      {
        id: "mistralai/voxtral-mini-transcribe-3-0",
        name: "Voxtral Mini Transcribe 3",
        description: "Mistral's fast, accurate multilingual transcription",
        descriptionKey:
          "models.descriptions.transcription.openrouter_mistralai_voxtral_mini_transcribe_3_0",
      },
      {
        id: "nvidia/nemotron-3.5-transcribe",
        name: "Nemotron 3.5 Transcribe",
        description: "NVIDIA's low-cost transcription in 40 languages",
        descriptionKey:
          "models.descriptions.transcription.openrouter_nvidia_nemotron_3_5_transcribe",
      },
      {
        id: "deepgram/nova-3",
        name: "Nova-3",
        description: "Deepgram's fast multilingual transcription",
        descriptionKey: "models.descriptions.transcription.openrouter_deepgram_nova_3",
      },
      {
        id: "assemblyai/universal-3-6-pro",
        name: "Universal-3.6 Pro",
        description: "AssemblyAI's most accurate transcription",
        descriptionKey: "models.descriptions.transcription.openrouter_assemblyai_universal_3_6_pro",
      },
      {
        id: "elevenlabs/scribe-v2",
        name: "Scribe v2",
        description: "ElevenLabs' accurate transcription in 90+ languages",
        descriptionKey: "models.descriptions.transcription.openrouter_elevenlabs_scribe_v2",
      },
      {
        id: "mistralai/voxtral-small-transcribe-3-0",
        name: "Voxtral Small Transcribe 3",
        description: "Mistral's larger multilingual transcription model",
        descriptionKey:
          "models.descriptions.transcription.openrouter_mistralai_voxtral_small_transcribe_3_0",
      },
      {
        id: "nvidia/parakeet-tdt-0.6b-v3",
        name: "Parakeet TDT 0.6B v3",
        description: "NVIDIA's low-cost transcription for European languages",
        descriptionKey: "models.descriptions.transcription.openrouter_nvidia_parakeet_tdt_0_6b_v3",
      },
      {
        id: "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
        name: "Nemotron 3.5 ASR 0.6B",
        description: "NVIDIA's lowest-cost multilingual transcription",
        descriptionKey:
          "models.descriptions.transcription.openrouter_nvidia_nemotron_3_5_asr_streaming_multilingual_0_6b",
      },
    ],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    baseUrl: "https://api.elevenlabs.io/v1",
    defaultModel: "scribe_v2",
    // Upload and Retry use this in place of the Note Recording-only realtime model.
    batchModel: "scribe_v2",
    models: [
      {
        id: "scribe_v2",
        name: "Scribe v2",
        description: "Accurate multilingual transcription",
        descriptionKey: "models.descriptions.transcription.elevenlabs_scribe_v2",
      },
      {
        id: "scribe_v2_realtime",
        name: "Scribe v2 Realtime",
        description: "Live transcription for note recording",
        descriptionKey: "models.descriptions.transcription.elevenlabs_scribe_v2_realtime",
        streaming: true,
        noteRecordingOnly: true,
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
