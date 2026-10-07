import topics from "../../config/productHelpTopics.json";
import type { HelpTopic, HelpResult, getHelpContext } from "./productHelp";

export const HELP_GUIDANCE_REVISION = "desktop-1.10.2-help-2026-10-07";
export interface HelpRequest {
  topics: HelpTopic[];
  unsupported: boolean;
  mixed: boolean;
}

// Conservative routing is deliberately independent of the selected model.
// These are help questions, never instructions to change a setting or search notes.
export function detectHelpRequest(
  text: string,
  previousTopics: HelpTopic[] = []
): HelpRequest | null {
  const value = text.toLowerCase();
  const product = /open\s?whispr/.test(value);
  const helpQuestion =
    /\b(how|what|which|show|tell|why|where|does|do i|can i|is|help|explain|check|using|current|currently|isn.t|not working|won.t)\b/.test(
      value
    );
  const matches: HelpTopic[] = [];
  const add = (topic: HelpTopic, pattern: RegExp) => {
    if (pattern.test(value)) matches.push(topic);
  };
  add(
    "hotkeys",
    /\b(hotkeys?|shortcuts?|dictation key|hold mode|tap mode|activation|push.to.talk|tap.to.talk)\b/
  );
  add("microphone", /\b(microphone|mic|input device)\b/);
  add(
    "models",
    /\b(local models?|offline|speech.to.text|stt|llm|language models?|processing|on my device|stays? on|privacy)\b/
  );
  add(
    "meetings",
    /\b(record.*meeting|meeting.*record|system audio|waiting for microphone|speaker labels)\b/
  );
  add("calendar", /\b(calendar)\b/);
  add(
    "language",
    /\b(transcription language|interface language|translation language|translate|languages?)\b/
  );
  add("backup", /\b(backup|sync.*devices|cloud sync)\b/);
  add(
    "assistant",
    /\b(chat|assistant|tools|app version|macos version|os version|operating system version)\b/
  );
  if (
    /\bhold\b/.test(value) &&
    /\b(mode|work|explain|dictation)\b/.test(value) &&
    !matches.includes("hotkeys")
  )
    matches.push("hotkeys");
  const followup =
    previousTopics.length > 0 &&
    /\b(again|now|current|currently|these|those|it|that|documentation|article|help)\b/.test(value);
  const appSpecific =
    (/\boffline\b/.test(value) && /\b(speech.to.text|language models?)\b/.test(value)) ||
    product ||
    /\b(dictation|hotkeys?|activation|hold mode|tap mode|transcription|openwhispr)\b/.test(value) ||
    /\b(my|choose|change|select|selection|using|input)\b.*\b(shortcuts?|microphone|mic)\b/.test(
      value
    ) ||
    /\boffline\b.*\b(dictation|chat|speech.to.text|language models?)\b/.test(value) ||
    /\b(app version|macos version|microphone|mic)\b/.test(value);
  if (!product && /\b(buy|recommend|purchase|best microphone)\b/.test(value)) return null;
  if (
    /\b(local|device|privacy)\b/.test(value) &&
    /\b(hold|holding|dictation)\b/.test(value) &&
    !matches.includes("models")
  )
    matches.push("models");
  if (!product && !followup && !(appSpecific && helpQuestion)) return null;
  if (!product && !helpQuestion && !followup) return null;
  const mixed =
    /\b(send|email|delete|search|summari[sz]e|find)\b.{0,50}\b(my notes|my emails|email to|message to|files|documents)\b/.test(
      value
    ) || /\b(and|also|then)\b.{0,25}\b(write|compose|calculate|search the web)\b/.test(value);
  const selected = matches.length ? matches : followup ? previousTopics : [];
  // Unknown named controls must not be confirmed merely because a known topic matches.
  const unknownControl = /\b(quantum|offline.only|gpt.?4.turbo|claude.?3)\b/.test(value);
  return {
    topics: [...new Set(selected)].slice(0, 4),
    unsupported: selected.length === 0 || unknownControl,
    mixed,
  };
}

type Context = Awaited<ReturnType<typeof getHelpContext>>;
export interface HelpDependencies {
  lookup: (topic: HelpTopic, signal: AbortSignal, page?: string) => Promise<HelpResult>;
  context: (topic: HelpTopic) => Promise<Context>;
}
const FACT_LABELS: Record<string, string> = {
  dictationKey: "Dictation shortcut",
  voiceAgentKey: "Voice Assistant shortcut",
  translationKey: "Translation shortcut",
  meetingKey: "Meeting shortcut",
  activationModeLabel: "Activation mode",
  microphoneSelectionModeLabel: "Microphone selection",
  selectedMicDeviceLabel: "Selected microphone",
  microphonePermission: "Microphone permission",
  accessibilityPermission: "Accessibility permission",
  systemAudioPermission: "System audio permission",
  dictationEngine: "Dictation engine",
  meetingEngine: "Meeting engine",
  uploadEngine: "Upload engine",
  transcriptionMode: "Dictation processing",
  meetingTranscriptionMode: "Meeting processing",
  uploadTranscriptionMode: "Upload processing",
  chatMode: "Chat processing",
  chatProvider: "Chat provider",
  agentAllowed: "Assistant allowed by policy",
  voiceAssistantMode: "Voice Assistant processing",
  cleanupMode: "Cleanup processing",
  uiLanguage: "Interface language",
  preferredLanguage: "Transcription language",
  cloudBackupEnabled: "Cloud backup",
  gcalConnected: "Google Calendar connected",
  mcalConnected: "Microsoft Calendar connected",
  appleCalendarConnected: "Apple Calendar connected",
};
const safeFact = (value: unknown): string =>
  typeof value === "boolean"
    ? value
      ? "On"
      : "Off"
    : typeof value === "string" && value.length <= 100 && !/[\r\n<>/@\\]|https?:|sk-/i.test(value)
      ? value
      : "Unknown";

function bounded<T>(work: Promise<T>, signal: AbortSignal, timeout: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const finish = (value: T | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const timer = setTimeout(() => finish(null), timeout);
    signal.addEventListener("abort", abort, { once: true });
    work.then(finish, () => finish(null));
    if (signal.aborted) abort();
  });
}

/** Reviewed answers are app content. Fetched prose is never executed or synthesized into claims. */
export async function runGroundedHelp(
  request: HelpRequest,
  signal: AbortSignal,
  deps: HelpDependencies
) {
  signal.throwIfAborted();
  const contexts: Array<Context & { topic: HelpTopic }> = [];
  const sources: Array<{
    title: string;
    path: string;
    url: string;
    source: "live" | "bundled";
    reason: HelpResult["reason"];
    retrievedAt: string | null;
  }> = [];
  const facts: Array<{ label: string; value: string }> = [];
  const answerStatus = request.mixed ? "clarify" : request.unsupported ? "abstained" : "answered";
  if (!request.mixed) {
    await Promise.all(
      request.topics.map(async (topic) => {
        const entry = topics[topic];
        const [context, evidence] = await Promise.all([
          bounded(deps.context(topic), signal, 3000),
          bounded(deps.lookup(topic, signal), signal, 14000),
        ]);
        signal.throwIfAborted();
        if (context) contexts.push({ ...context, topic });
        const validated = evidence?.articles.find(
          (article) =>
            article.path === entry.path &&
            article.url === `https://docs.openwhispr.com${entry.path}`
        );
        sources.push({
          title: topic,
          path: entry.path,
          url: `https://docs.openwhispr.com${entry.path}`,
          source: validated && evidence?.source === "live" ? "live" : "bundled",
          reason: validated ? (evidence?.reason ?? null) : "unavailable",
          retrievedAt: validated ? (evidence?.retrievedAt ?? null) : null,
        });
      })
    );
  }
  // Stable ordering regardless of network completion order.
  contexts.sort((a, b) => request.topics.indexOf(a.topic) - request.topics.indexOf(b.topic));
  sources.sort(
    (a, b) =>
      request.topics.indexOf(a.title as HelpTopic) - request.topics.indexOf(b.title as HelpTopic)
  );
  const seen = new Set<string>();
  const addFact = (label: string, value: unknown) => {
    if (!seen.has(label)) {
      seen.add(label);
      facts.push({ label, value: safeFact(value) });
    }
  };
  for (const context of contexts) {
    addFact("App version", context.version);
    addFact(
      "Platform",
      context.platform === "darwin"
        ? "macOS"
        : context.platform === "win32"
          ? "Windows"
          : context.platform
    );
    addFact("OS version", null);
    for (const [key, value] of Object.entries(context.values))
      if (FACT_LABELS[key]) addFact(FACT_LABELS[key], value);
    if (context.values.activationModeLabel == null && context.values.activationMode != null)
      addFact(
        "Activation mode",
        context.values.activationMode === "push"
          ? "Hold"
          : context.values.activationMode === "tap"
            ? "Tap"
            : null
      );
    if (
      context.values.microphoneSelectionModeLabel == null &&
      context.values.microphoneSelectionMode != null
    )
      addFact(
        "Microphone selection",
        context.values.microphoneSelectionMode === "system"
          ? "System Default"
          : context.values.microphoneSelectionMode === "specific"
            ? "Selected device"
            : null
      );
  }
  const content = request.mixed
    ? "I can show read-only OpenWhispr help here. Please ask the product-help question separately from the other action; I have not performed that action."
    : request.unsupported
      ? "I cannot verify that feature or control from the built-in OpenWhispr guidance. I have not changed any settings. Check the official documentation or describe the setting you can see."
      : request.topics.map((topic) => topics[topic].text).join("\n\n");
  return {
    content,
    metadata: {
      kind: "grounded-help",
      topics: request.topics,
      answerStatus,
      revision: HELP_GUIDANCE_REVISION,
      sources,
      facts,
      contexts,
      readAt: contexts[0]?.readAt ?? new Date().toISOString(),
    },
  };
}
