import i18n from "../../i18n";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./ToolRegistry";
import { requestInteraction, takeGrantedImage } from "../../stores/agentInteractionStore";
import { approvalKey } from "../../stores/connectorApprovalStore";
import { SETTINGS_TARGETS } from "../../helpers/settingsTargets.js";
import { CONNECTION_TARGET_NAMES } from "../../config/agentCapabilities";
import { getProviderDisplayName } from "../../models/ModelRegistry";
import { answerText, optionLabel } from "../../utils/interactionAnswers";
import type {
  ConnectionTarget,
  InteractionPayload,
  InteractionQuestion,
  InteractionResult,
} from "../../types/agentInteractions";

/** What the interaction tools can actually do in this send; each registers only when it can act. */
export interface InteractionToolOptions {
  /** Targets the user can connect from the chat: available here, not connected yet. */
  connectionTargets: readonly ConnectionTarget[];
  /** BYOK providers whose key is missing. */
  missingKeyProviders: readonly string[];
  /** A screenshot can reach the model answering this send. */
  screenAccess: boolean;
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;
const MAX_PROMPT_CHARS = 300;
const MAX_LABEL_CHARS = 120;
const MAX_REASON_CHARS = 200;

const ASK_ONCE = "Don't ask the same thing again in this request.";

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function invalidResult(error: string): ToolResult {
  return {
    success: true,
    data: { status: "invalid", error, guidance: "Fix the call and try again." },
    displayText: i18n.t("agentMode.interactions.status.invalid"),
  };
}

function noContextResult(): ToolResult {
  return {
    success: true,
    data: { status: "unavailable", reason: "no_chat_context" },
    displayText: i18n.t("connectors.toolStatus.unavailable"),
  };
}

// What every interaction reports when it didn't get the answer it asked for.
function unansweredResult(result: InteractionResult): ToolResult {
  switch (result.status) {
    case "cancelled":
    case "declined":
      return {
        success: true,
        data: {
          status: result.status === "cancelled" ? "cancelled_by_user" : "declined",
          guidance: `The user said no. ${ASK_ONCE} Continue with what you can do without it, or stop and say what is missing.`,
        },
        displayText: i18n.t(`agentMode.interactions.status.${result.status}`),
      };
    case "unavailable":
      return {
        success: true,
        data: {
          status: "unavailable",
          reason: result.reason,
          guidance: `It can't be done right now. ${ASK_ONCE} Tell the user briefly.`,
        },
        displayText: i18n.t("connectors.toolStatus.unavailable"),
      };
    default:
      return {
        success: true,
        data: {
          status: "not_answered",
          ...(result.status === "not_answered" ? { reason: result.reason } : {}),
          guidance:
            "The user didn't answer. Stop here and briefly say what you still need; don't guess.",
        },
        displayText: i18n.t("agentMode.interactions.status.notAnswered"),
      };
  }
}

function parseQuestions(value: unknown): InteractionQuestion[] | string {
  if (!Array.isArray(value) || value.length === 0) return "questions must be a non-empty list";
  if (value.length > MAX_QUESTIONS) return `ask at most ${MAX_QUESTIONS} questions at once`;
  const questions: InteractionQuestion[] = [];
  for (const raw of value as Array<Record<string, unknown>>) {
    const id = text(raw?.id, 60);
    const prompt = text(raw?.prompt, MAX_PROMPT_CHARS);
    const kind = raw?.kind;
    if (!id || !prompt || questions.some((q) => q.id === id)) {
      return "each question needs a unique id and a prompt";
    }
    if (kind === "text") {
      const placeholder = text(raw.placeholder, MAX_LABEL_CHARS);
      questions.push({ id, kind, prompt, ...(placeholder ? { placeholder } : {}) });
      continue;
    }
    if (kind !== "single" && kind !== "multiple") return `unknown question kind for "${id}"`;
    const options = (Array.isArray(raw.options) ? raw.options : [])
      .slice(0, MAX_OPTIONS)
      .map((option: Record<string, unknown>) => ({
        id: text(option?.id, 60),
        label: text(option?.label, MAX_LABEL_CHARS),
        ...(option?.recommended === true ? { recommended: true } : {}),
      }));
    const ids = new Set(options.map((option) => option.id));
    if (
      options.length < 2 ||
      options.some((o) => !o.id || !o.label) ||
      ids.size !== options.length
    ) {
      return `"${id}" needs at least two options, each with a unique id and a label`;
    }
    questions.push({ id, kind, prompt, options });
  }
  return questions;
}

// Answers as the model reads them: chosen option labels, or the typed text.
function answerLabels(
  questions: readonly InteractionQuestion[],
  answers: Record<string, string | string[]>
): Record<string, string | string[]> {
  return Object.fromEntries(
    questions.map((question) => {
      const answer = answers[question.id];
      return [
        question.id,
        Array.isArray(answer)
          ? answer.map((id) => optionLabel(question, id))
          : optionLabel(question, answer),
      ];
    })
  );
}

const askUserTool: ToolDefinition = {
  name: "ask_user",
  description:
    "Ask the user one or more questions and wait for the answers. Only for something the request, the context and your other tools couldn't settle, where a wrong guess would matter. Never ask for a pull request, issue, person, email address, channel or note before you have searched for it with your tools. Put every question you still need into this one call. kind: single (pick one option), multiple (pick any options), text (type an answer). Options need ids and labels; mark at most one option recommended when one is clearly better (the user still picks).",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["single", "multiple", "text"] },
            prompt: { type: "string", description: "The question, as the user reads it" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  recommended: { type: "boolean" },
                },
                required: ["id", "label"],
                additionalProperties: false,
              },
            },
            placeholder: { type: "string", description: "Hint shown in an empty text answer" },
          },
          required: ["id", "kind", "prompt"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  readOnly: true,
  promptInstruction:
    "Use ask_user only when you can't reasonably decide something yourself from the request, the conversation or your tools, and a wrong guess would matter. Never ask for something a tool can look up; look it up first. Never ask the user to type or paste an API key, password or token into the chat.",
  async execute(args, context) {
    const questions = parseQuestions(args.questions);
    if (typeof questions === "string") return invalidResult(questions);
    if (!context) return noContextResult();
    const result = await requestInteraction(context, { kind: "questions", questions });
    if (result.status !== "answered") return unansweredResult(result);
    const answerLines = questions.map(
      (question) => `${question.prompt} ${answerText(question, result.answers[question.id])}`
    );
    return {
      success: true,
      data: { status: "answered", answers: answerLabels(questions, result.answers) },
      // The step reads "Answered" and expands to what the user chose.
      displayText: [i18n.t("agentMode.interactions.status.answered"), ...answerLines].join("\n"),
    };
  },
};

// Calls running in parallel that need the same service share one card, so one
// connect flow runs and its answer reaches them all.
const openConnections = new Map<ConnectionTarget, Promise<InteractionResult>>();

function requestConnection(
  context: ToolExecutionContext,
  payload: Extract<InteractionPayload, { kind: "connection" }>
): Promise<InteractionResult> {
  const open = openConnections.get(payload.target);
  if (open) {
    // A call that joins another's card waits the same way, so a stop marks it unsent too.
    context.onInteraction({ payload, state: "pending" });
    return open.then((result) => {
      context.onInteraction({ payload, state: "settled", result });
      return result;
    });
  }
  const request = requestInteraction(context, payload).finally(() =>
    openConnections.delete(payload.target)
  );
  openConnections.set(payload.target, request);
  return request;
}

function createConnectionTool(targets: readonly ConnectionTarget[]): ToolDefinition {
  return {
    name: "request_connection",
    description: `Ask the user to connect a service the request needs, and wait while they do. Targets: ${targets
      .map((target) => `${target} (${CONNECTION_TARGET_NAMES[target]})`)
      .join(
        ", "
      )}. "calendar" lets the user pick their calendar provider. Once it connects, continue the task with that service's tools.`,
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: [...targets] },
        reason: {
          type: "string",
          description: "One short sentence the user reads: what connecting lets you do for them",
        },
      },
      required: ["target", "reason"],
      additionalProperties: false,
    },
    readOnly: true,
    promptInstruction:
      "The tools of a service that isn't connected yet ask the user to connect it when you call them. Use request_connection only to connect one no tool of yours needs yet, and never just tell the user to connect something themselves.",
    async execute(args, context) {
      const target = targets.find((candidate) => candidate === args.target);
      if (!target) return invalidResult(`target must be one of: ${targets.join(", ")}`);
      if (!context) return noContextResult();
      const reason = text(args.reason, MAX_REASON_CHARS);
      const result = await requestConnection(context, {
        kind: "connection",
        target,
        ...(reason ? { reason } : {}),
      });
      if (result.status !== "connected") return unansweredResult(result);
      const name = CONNECTION_TARGET_NAMES[result.target];
      return {
        success: true,
        data: {
          status: "connected",
          target: result.target,
          // email_draft's description still says it opens a draft, written before Gmail connected.
          guidance:
            result.target === "gmail"
              ? "Gmail is connected now. Continue with email_draft: unless the user picked another app for drafts, it now sends from here once they approve the email on a card."
              : `${name} is connected now. Continue the user's request with its tools.`,
        },
        displayText: i18n.t("agentMode.interactions.status.connected", { name }),
      };
    },
  };
}

const requestAccessTool: ToolDefinition = {
  name: "request_access",
  description:
    "Ask the user to let you see their screen once: if they allow it, a screenshot of their current screen is attached to your next step. Use it only when the request is about something on their screen that you can't get any other way.",
  parameters: {
    type: "object",
    properties: {
      resource: { type: "string", enum: ["screen"] },
      reason: { type: "string", description: "One short sentence the user reads: why you need it" },
    },
    required: ["resource", "reason"],
    additionalProperties: false,
  },
  readOnly: true,
  async execute(args, context) {
    if (args.resource !== "screen") return invalidResult('resource must be "screen"');
    if (!context) return noContextResult();
    const reason = text(args.reason, MAX_REASON_CHARS);
    const payload: InteractionPayload = { kind: "access", resource: "screen", reason };
    const result = await requestInteraction(context, payload);
    if (result.status !== "granted") return unansweredResult(result);
    const image = takeGrantedImage(approvalKey(context.messageId, context.toolCallId));
    if (image) context.attachImage(image);
    return {
      success: true,
      data: {
        status: "granted",
        guidance: "A screenshot of the user's screen follows. Use it to answer.",
      },
      displayText: i18n.t("agentMode.interactions.status.granted"),
    };
  },
};

function createApiKeyTool(providers: readonly string[]): ToolDefinition {
  return {
    name: "request_api_key",
    description: `Ask the user for their own API key for one of these model providers: ${providers.join(", ")}. Only when they want to use their own account with a provider whose key is missing. They enter it in a masked field that saves it straight to their settings; you never see the key.`,
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...providers] },
        reason: { type: "string", description: "One short sentence the user reads" },
      },
      required: ["provider"],
      additionalProperties: false,
    },
    readOnly: false,
    promptInstruction:
      "When the user wants to use a model provider's API key they haven't added, use request_api_key: it saves the key without you seeing it.",
    async execute(args, context) {
      const provider = providers.find((candidate) => candidate === args.provider);
      if (!provider) return invalidResult(`provider must be one of: ${providers.join(", ")}`);
      if (!context) return noContextResult();
      const reason = text(args.reason, MAX_REASON_CHARS);
      const result = await requestInteraction(context, {
        kind: "apiKey",
        provider,
        providerName: getProviderDisplayName(provider),
        ...(reason ? { reason } : {}),
      });
      if (result.status !== "saved") return unansweredResult(result);
      return {
        success: true,
        data: {
          status: "saved",
          provider,
          guidance: "The key is saved in the user's settings. Never repeat or ask for its value.",
        },
        displayText: i18n.t("agentMode.interactions.status.saved"),
      };
    },
  };
}

const openSettingsTool: ToolDefinition = {
  name: "open_settings",
  description: `Show the user a button that opens the settings page where they can fix something you can't, and wait until they say they're done. Targets: llms (AI models), speechToText, privacyData (permissions and data), integrations.connectors, integrations.calendars.`,
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", enum: [...SETTINGS_TARGETS] },
      message: { type: "string", description: "What the user should do there, in one sentence" },
      technical_details: {
        type: "string",
        description: "Optional error details the user can expand",
      },
    },
    required: ["target", "message"],
    additionalProperties: false,
  },
  readOnly: true,
  async execute(args, context) {
    const target = SETTINGS_TARGETS.find((candidate) => candidate === args.target);
    if (!target) return invalidResult(`target must be one of: ${SETTINGS_TARGETS.join(", ")}`);
    if (!context) return noContextResult();
    const message = text(args.message, MAX_REASON_CHARS);
    const technicalDetails = text(args.technical_details, 2000);
    const result = await requestInteraction(context, {
      kind: "settings",
      target,
      ...(message ? { message } : {}),
      ...(technicalDetails ? { technicalDetails } : {}),
    });
    if (result.status !== "done") return unansweredResult(result);
    return {
      success: true,
      data: {
        status: "done",
        ...(result.ready !== undefined ? { ready: result.ready } : {}),
        guidance:
          result.ready === false
            ? "The user is back from Settings, but it still isn't set up. Say what is missing."
            : "The user is back from Settings. Continue the request; if it still fails, say what is missing.",
      },
      displayText: i18n.t("agentMode.interactions.status.done"),
    };
  },
};

export function createInteractionTools(options: InteractionToolOptions): ToolDefinition[] {
  return [
    askUserTool,
    ...(options.connectionTargets.length > 0
      ? [createConnectionTool(options.connectionTargets)]
      : []),
    ...(options.screenAccess ? [requestAccessTool] : []),
    ...(options.missingKeyProviders.length > 0
      ? [createApiKeyTool(options.missingKeyProviders)]
      : []),
    openSettingsTool,
  ];
}

/**
 * A tool whose service can be connected from the chat: registered before it
 * is, so the turn that needs it can connect it. Called while it isn't
 * connected, it asks the user to connect it and then does what it was asked,
 * so the task carries on without the model having to start it again.
 */
export function requireConnection(
  tool: ToolDefinition,
  target: ConnectionTarget,
  isReady: () => boolean
): ToolDefinition {
  return {
    ...tool,
    async execute(args, context?: ToolExecutionContext) {
      if (!isReady()) {
        const result = context
          ? await requestConnection(context, { kind: "connection", target })
          : ({ status: "unavailable", reason: "not_connected" } as const);
        if (result.status !== "connected") return unansweredResult(result);
      }
      return tool.execute(args, context);
    },
  };
}
