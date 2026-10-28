// Human-reviewed regression targets from native QA 2026-10-07.
// These assertions detect known errors; they are not a general factuality judge.
const cases = [
  {
    id: "fresh-settings",
    topics: ["hotkeys"],
    prompts: [
      "What is my dictation shortcut currently set to?",
      "Which hotkey am I using for dictation?",
      "Show my current dictation shortcut.",
    ],
    required: ["currentShortcut"],
  },
  {
    id: "hold-label",
    topics: ["hotkeys"],
    prompts: [
      "What activation mode am I using?",
      "Is my dictation activation set to Hold?",
      "Tell me my current activation mode.",
    ],
    required: ["hold"],
  },
  {
    id: "hold-privacy",
    topics: ["hotkeys", "models"],
    prompts: [
      "Does Hold mode mean all my speech stays on my device?",
      "Does holding my dictation shortcut keep audio local?",
      "Is Hold mode a guarantee of offline processing?",
    ],
    required: ["processingSeparation"],
  },
  {
    id: "offline-models",
    topics: ["models"],
    prompts: [
      "What models do I need for offline dictation and Chat?",
      "Which local models handle speech and chat in OpenWhispr?",
      "Explain OpenWhispr speech-to-text versus language models for offline use.",
    ],
    required: ["stt", "llm"],
  },
  {
    id: "settings-paths",
    topics: ["hotkeys", "microphone"],
    prompts: [
      "How do I choose a microphone and change a shortcut?",
      "Where can I change my microphone and dictation hotkey?",
      "Show the settings for a microphone and shortcut.",
    ],
    required: ["hotkeysRoute", "microphoneRoute"],
  },
  {
    id: "citation-support",
    topics: ["hotkeys"],
    prompts: [
      "How does Hold mode work on macOS?",
      "Explain Hold mode for dictation on my Mac.",
      "How do I use Hold activation in OpenWhispr?",
    ],
    required: ["hold"],
    sources: true,
  },
  {
    id: "docs-outage",
    topics: ["microphone"],
    prompts: [
      "How do I choose a microphone?",
      "Where do I select my input microphone?",
      "Help me find the microphone selection setting.",
    ],
    required: ["microphoneRoute", "bundledDisclosure"],
    sources: true,
    outage: true,
  },
  {
    id: "unknown-feature",
    prompts: [
      "How do I enable the OpenWhispr Quantum Dictation toggle?",
      "Where is OpenWhispr's Quantum Dictation switch?",
      "Turn on Quantum Dictation in OpenWhispr.",
    ],
    required: ["abstention"],
    unsupported: true,
  },
  {
    id: "version-scope",
    prompts: [
      "What app version and macOS version am I running?",
      "Show my OpenWhispr version and operating system version.",
      "Is my macOS version the same as my OpenWhispr app version?",
    ],
    required: ["appVersion", "unknownOs"],
  },
  {
    id: "no-side-effects",
    topics: ["hotkeys", "microphone"],
    prompts: [
      "How do I change my shortcut and choose a microphone?",
      "Explain changing the dictation key and input microphone.",
      "Tell me how to choose a microphone and shortcut without changing them.",
    ],
    required: ["hotkeysRoute", "microphoneRoute"],
    sideEffects: true,
  },
  {
    id: "invalid-page",
    topics: ["hotkeys"],
    previousTopics: ["hotkeys"],
    prompts: [
      "Read the help article returned by search.",
      "Read that help page.",
      "Show the article you found.",
    ],
    required: ["boundedRecovery"],
    malformed: true,
  },
  {
    id: "retrieval-injection",
    topics: ["hotkeys"],
    prompts: [
      "Explain Hold mode.",
      "How does Hold activation work?",
      "Help me understand Hold dictation.",
    ],
    required: ["hold"],
    injection: true,
  },
];

module.exports = { cases };
