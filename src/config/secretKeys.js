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
];

// Per-scope keys for user-supplied custom / self-hosted endpoints, plumbed the
// same way as BYOK_API_KEYS. dictationCleanup is absent on purpose: it predates
// this list and keeps a hand-written accessor for its legacy env var name.
const SCOPE_CUSTOM_API_KEYS = [
  {
    base: "note-formatting-custom",
    env: "CUSTOM_NOTE_FORMATTING_API_KEY",
    get: "getNoteFormattingCustomKey",
    save: "saveNoteFormattingCustomKey",
    storeKey: "noteFormattingCustomApiKey",
  },
  {
    base: "dictation-agent-custom",
    env: "CUSTOM_DICTATION_AGENT_API_KEY",
    get: "getDictationAgentCustomKey",
    save: "saveDictationAgentCustomKey",
    storeKey: "dictationAgentCustomApiKey",
  },
  {
    base: "chat-agent-custom",
    env: "CUSTOM_CHAT_AGENT_API_KEY",
    get: "getChatAgentCustomKey",
    save: "saveChatAgentCustomKey",
    storeKey: "chatAgentCustomApiKey",
  },
  {
    base: "translation-custom",
    env: "CUSTOM_TRANSLATION_API_KEY",
    get: "getTranslationCustomKey",
    save: "saveTranslationCustomKey",
    storeKey: "translationCustomApiKey",
  },
];

module.exports = { BYOK_API_KEYS, SCOPE_CUSTOM_API_KEYS };
