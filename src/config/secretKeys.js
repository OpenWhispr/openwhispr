// Single source of truth for the uniform BYOK cloud-LLM API-key secrets:
// environment.js, ipcHandlers.js and the settings store all derive their
// per-key plumbing from this list, so adding a provider is one entry.
// CommonJS + pure data so both the main process and the Vite renderer share it.
// `base` yields the IPC channels `get-<base>-key` / `save-<base>-key`.
// preload.js can't require local modules under sandbox, so it mirrors the
// {base, get, save} tuples inline — keep BYOK_KEY_BRIDGES there in sync
// (guarded by test/helpers/secretKeys.test.js).
const BYOK_API_KEYS = [
  {
    base: "openai",
    env: "OPENAI_API_KEY",
    get: "getOpenAIKey",
    save: "saveOpenAIKey",
    storeKey: "openaiApiKey",
  },
  {
    base: "anthropic",
    env: "ANTHROPIC_API_KEY",
    get: "getAnthropicKey",
    save: "saveAnthropicKey",
    storeKey: "anthropicApiKey",
  },
  {
    base: "gemini",
    env: "GEMINI_API_KEY",
    get: "getGeminiKey",
    save: "saveGeminiKey",
    storeKey: "geminiApiKey",
  },
  {
    base: "groq",
    env: "GROQ_API_KEY",
    get: "getGroqKey",
    save: "saveGroqKey",
    storeKey: "groqApiKey",
  },
  { base: "xai", env: "XAI_API_KEY", get: "getXaiKey", save: "saveXaiKey", storeKey: "xaiApiKey" },
  {
    base: "mistral",
    env: "MISTRAL_API_KEY",
    get: "getMistralKey",
    save: "saveMistralKey",
    storeKey: "mistralApiKey",
  },
  {
    base: "openrouter",
    env: "OPENROUTER_API_KEY",
    get: "getOpenrouterKey",
    save: "saveOpenrouterKey",
    storeKey: "openrouterApiKey",
  },
  {
    base: "tinfoil",
    env: "TINFOIL_API_KEY",
    get: "getTinfoilKey",
    save: "saveTinfoilKey",
    storeKey: "tinfoilApiKey",
  },
  {
    base: "corti",
    env: "CORTI_API_KEY",
    get: "getCortiKey",
    save: "saveCortiKey",
    storeKey: "cortiApiKey",
  },
  // OpenCode sells two products on one host: Go (flat-rate subscription,
  // /zen/go/v1) and Zen (pay-as-you-go, /zen/v1). They are separate
  // subscriptions, so each keeps its own key, the way Hermes names them.
  {
    base: "opencode-go",
    env: "OPENCODE_GO_API_KEY",
    get: "getOpencodeGoKey",
    save: "saveOpencodeGoKey",
    storeKey: "opencodeGoApiKey",
  },
  {
    base: "opencode-zen",
    env: "OPENCODE_ZEN_API_KEY",
    get: "getOpencodeZenKey",
    save: "saveOpencodeZenKey",
    storeKey: "opencodeZenApiKey",
  },
  // `get`/`save` are taken verbatim, never derived from `base`, so these keep
  // the capitalisation realtimeTokenProviders.js already calls them by.
  {
    base: "deepgram",
    env: "DEEPGRAM_API_KEY",
    get: "getDeepgramKey",
    save: "saveDeepgramKey",
    storeKey: "deepgramApiKey",
  },
  {
    base: "assemblyai",
    env: "ASSEMBLYAI_API_KEY",
    get: "getAssemblyAIKey",
    save: "saveAssemblyAIKey",
    storeKey: "assemblyaiApiKey",
  },
  // Per-scope Custom-endpoint keys. Dictation cleanup's counterpart predates
  // this manifest and keeps its bespoke accessors (CUSTOM_CLEANUP_API_KEY).
  {
    base: "note-formatting-custom",
    env: "NOTE_FORMATTING_CUSTOM_API_KEY",
    get: "getNoteFormattingCustomKey",
    save: "saveNoteFormattingCustomKey",
    storeKey: "noteFormattingCustomApiKey",
  },
  {
    base: "translation-custom",
    env: "TRANSLATION_CUSTOM_API_KEY",
    get: "getTranslationCustomKey",
    save: "saveTranslationCustomKey",
    storeKey: "translationCustomApiKey",
  },
  {
    base: "dictation-agent-custom",
    env: "DICTATION_AGENT_CUSTOM_API_KEY",
    get: "getDictationAgentCustomKey",
    save: "saveDictationAgentCustomKey",
    storeKey: "dictationAgentCustomApiKey",
  },
  {
    base: "dictation-agent-vision-custom",
    env: "DICTATION_AGENT_VISION_CUSTOM_API_KEY",
    get: "getDictationAgentVisionCustomKey",
    save: "saveDictationAgentVisionCustomKey",
    storeKey: "dictationAgentVisionCustomApiKey",
  },
  {
    base: "chat-agent-custom",
    env: "CHAT_AGENT_CUSTOM_API_KEY",
    get: "getChatAgentCustomKey",
    save: "saveChatAgentCustomKey",
    storeKey: "chatAgentCustomApiKey",
  },
];

module.exports = { BYOK_API_KEYS };
