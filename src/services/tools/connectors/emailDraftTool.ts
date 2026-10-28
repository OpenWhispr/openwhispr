import i18n from "../../../i18n";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../ToolRegistry";
import {
  bareEmailAddress,
  buildComposeRequest,
  isValidEmailAddress,
  recipientLabel,
} from "../../../helpers/connectors/emailCompose";
import type { ApprovalEdits, ConnectorDirectResult } from "../../../types/connectors";
import type { ComposeTarget, EmailDraftTarget } from "../../../utils/emailDraftTarget";
import { getCachedPlatform } from "../../../utils/platform";
import { useConnectorStatusStore } from "../../../stores/connectorStatusStore";
import { connectorErrorText } from "../../../utils/connectorErrorCopy";
import { runApprovalAction } from "./runApprovalAction";
import {
  failedResult,
  needsClarificationResult,
  notSentResult,
  unavailableResult,
  unknownResult,
  userEdits,
} from "./toolOutcome";
import { findContactTool } from "./findContactTool";
import type { ConnectorToolModule } from "./connectorToolModules";

// Enough for "email Josh and Dana each a recap"; a model stuck in a loop, or
// following an injected instruction, can't bury the user in compose windows
// or cards.
const MAX_DRAFTS_PER_TURN = 3;

const GMAIL_RECONNECT_GUIDANCE =
  "Tell the user to reconnect Gmail under Settings → Integrations → Connectors. Don't retry.";
const GMAIL_UNKNOWN_GUIDANCE = "Tell the user to check their Gmail Sent folder.";

// One line for both paths: the tool's own description says whether a card
// or the user's mail app sends it.
const EMAIL_DRAFT_INSTRUCTION =
  "Use email_draft to draft an email to full email addresses; its description says whether the user sends it from a card in the chat or from their own email app.";

const EMAIL_PARAMETERS: ToolDefinition["parameters"] = {
  type: "object",
  properties: {
    to: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "Recipient email addresses",
    },
    cc: { type: "array", items: { type: "string" }, description: "Cc email addresses" },
    subject: { type: "string", description: "Subject line" },
    body: { type: "string", description: "Plain-text body; blank lines between paragraphs" },
  },
  required: ["to", "subject", "body"],
  additionalProperties: false,
};

function addressList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map(bareEmailAddress)
    : [];
}

interface Recipients {
  to: string[];
  cc: string[];
}

// Names and malformed addresses go back to the model, which fixes the call
// or looks the person up; nothing is prepared or opened for them.
function recipientsOrQuestion(args: Record<string, unknown>): Recipients | ToolResult {
  const to = addressList(args.to);
  const cc = addressList(args.cc);
  const invalid = [...to, ...cc].filter((address) => !isValidEmailAddress(address));
  if (to.length === 0 || invalid.length > 0) {
    const rejected = invalid.map((address) => JSON.stringify(address)).join(", ");
    return needsClarificationResult(
      `Every recipient must be an email address like name@example.com${rejected ? ` (not ${rejected})` : ""}. If you already know the address, call email_draft again with it. If you only have a name, call find_contact first.`
    );
  }
  return { to, cc };
}

function isToolResult(value: Recipients | ToolResult): value is ToolResult {
  return "success" in value;
}

interface Overflow {
  subject: boolean;
  body: boolean;
}

function overflowedText({ subject, body }: Overflow): string {
  return subject && body ? "subject and body" : subject ? "subject" : "body";
}

function draftOpenedGuidance(
  result: Extract<ConnectorDirectResult, { state: "sent" }>,
  overflow: Overflow
): string {
  if (result.copyFailed) {
    const text = overflowedText(overflow);
    return `The draft opened, but its ${text} didn't fit in a link and couldn't be copied to the clipboard. Put the ${text} in your reply so the user can paste it into the draft.`;
  }
  if (result.subjectCopied && result.bodyCopied) {
    return "The subject and body were too long for a link, so they are on the user's clipboard (subject first, then a blank line, then the body). Tell them to paste the subject and body into the draft.";
  }
  if (result.subjectCopied) {
    return "The subject was too long for a link, so it is on the user's clipboard. Tell them to paste it into the subject line.";
  }
  if (result.bodyCopied) {
    return "The body was too long for a link, so it is on the user's clipboard. Tell them to paste it into the draft.";
  }
  return "Tell the user the draft is open for them to review and send.";
}

// The tool step reads "Gmail needs to be reconnected.", the same copy a
// failed reconnect_needed step shows, not the generic "connectors unavailable".
function gmailReconnectResult(edits: ApprovalEdits = {}): ToolResult {
  return {
    ...unavailableResult("reconnect_needed", GMAIL_RECONNECT_GUIDANCE, edits),
    displayText: connectorErrorText(i18n.t, "toolStatus", "gmail", "reconnect_needed"),
  };
}

function resultStatus(result: ToolResult): string | undefined {
  const data = result.data as { status?: unknown } | null;
  return typeof data?.status === "string" ? data.status : undefined;
}

function isReconnectFailure(result: ToolResult): boolean {
  const data = result.data as { status?: unknown; errorCode?: unknown } | null;
  return data?.status === "failed" && data.errorCode === "reconnect_needed";
}

function createGmailSendTool(): ToolDefinition {
  return {
    name: "email_draft",
    description:
      "Write an email for the user to send from their connected Gmail account. It appears on a card in the chat where the user reviews, edits and sends it themselves; nothing is sent until they press Send. `to` and `cc` must be full email addresses; call find_contact first when you only have a name.",
    parameters: EMAIL_PARAMETERS,
    readOnly: false,
    connectorId: "email",
    promptInstruction: EMAIL_DRAFT_INSTRUCTION,

    async execute(
      args: Record<string, unknown>,
      context?: ToolExecutionContext
    ): Promise<ToolResult> {
      // Every outcome keeps the turn off the caret: a card, a question back
      // and a receipt all belong in the panel, never in the user's document.
      context?.onHoldDelivery();
      const recipients = recipientsOrQuestion(args);
      if (isToolResult(recipients)) return recipients;
      if (context?.signal.aborted) return notSentResult("cancelled");

      // Read live, not when the registry was built: a login can lapse
      // mid-conversation. No compose window stands in for it (spec §4.3).
      const gmail = useConnectorStatusStore.getState().statuses.gmail;
      if (gmail?.connected && gmail.needsReconnect) return gmailReconnectResult();

      if (context && !context.claimTurnSlot("email_draft", MAX_DRAFTS_PER_TURN)) {
        return notSentResult(
          "draft_limit",
          `Only ${MAX_DRAFTS_PER_TURN} emails can be prepared per request. Tell the user which emails are ready and ask them to request the rest again.`,
          i18n.t("connectors.toolStatus.gmailDraftLimit", { max: MAX_DRAFTS_PER_TURN })
        );
      }
      const result = await runApprovalAction(
        context,
        "gmail",
        "send",
        {
          to: recipients.to,
          cc: recipients.cc,
          subject: typeof args.subject === "string" ? args.subject : "",
          body: typeof args.body === "string" ? args.body : "",
        },
        { unknownGuidance: GMAIL_UNKNOWN_GUIDANCE }
      );
      // A sent or unconfirmed email may have gone out, so it keeps its slot;
      // one that never went out gives it back for a retry in the same turn.
      const status = resultStatus(result);
      if (status !== "sent" && status !== "unknown") context?.releaseTurnSlot("email_draft");
      // The card itself shows a Send-time reconnect as failed; the model gets
      // the same instruction either way: send the user to Settings. The
      // user's edits ride along, so a later "send it again" uses their email.
      return isReconnectFailure(result)
        ? gmailReconnectResult(userEdits((result.data ?? {}) as ApprovalEdits))
        : result;
    },
  };
}

function createComposeDraftTool(target: ComposeTarget): ToolDefinition {
  return {
    name: "email_draft",
    description:
      "Open a pre-filled email draft in the user's email app so they can review and send it themselves. This never sends email. `to` and `cc` must be full email addresses; call find_contact first when you only have a name.",
    parameters: EMAIL_PARAMETERS,
    readOnly: false,
    connectorId: "email",
    promptInstruction: EMAIL_DRAFT_INSTRUCTION,

    async execute(
      args: Record<string, unknown>,
      context?: ToolExecutionContext
    ): Promise<ToolResult> {
      // Every outcome keeps the turn off the caret: an opened compose window
      // takes focus, and a question back must not land in the user's document.
      context?.onHoldDelivery();
      const recipients = recipientsOrQuestion(args);
      if (isToolResult(recipients)) return recipients;
      const { to, cc } = recipients;

      if (context?.signal.aborted) return notSentResult("cancelled");
      const draft = {
        target,
        to,
        cc,
        subject: typeof args.subject === "string" ? args.subject : "",
        body: typeof args.body === "string" ? args.body : "",
      };
      // Main builds the same request; checking it here claims the clipboard
      // before any await, so a second overflowing draft in the turn can't
      // replace the first one's text before the user pastes it. Main refuses
      // to use the clipboard unless this draft reserved it. Built before the
      // slots are claimed, so nothing can throw between a claim and its release.
      const preview = buildComposeRequest({ ...draft, platform: getCachedPlatform() });
      const clipboardReserved = preview.ok && preview.clipboardText !== null;
      const overflow = {
        subject: preview.ok && preview.subjectCopied,
        body: preview.ok && preview.bodyCopied,
      };
      // Shown to the user and in guidance with any punycode form; the data
      // keeps bare addresses so the model can reuse them in a retry.
      const destination = to.map(recipientLabel).join(", ");

      if (context && !context.claimTurnSlot("email_draft", MAX_DRAFTS_PER_TURN)) {
        return notSentResult(
          "draft_limit",
          `Only ${MAX_DRAFTS_PER_TURN} drafts can open per request. Tell the user which drafts opened and ask them to request the rest again.`,
          i18n.t("connectors.toolStatus.draftLimit", { max: MAX_DRAFTS_PER_TURN })
        );
      }
      if (clipboardReserved && context && !context.claimTurnSlot("clipboard", 1)) {
        context.releaseTurnSlot("email_draft");
        return notSentResult(
          "clipboard_in_use",
          "This draft is too long for a link, and its text would replace another draft's text on the clipboard. Tell the user to paste the earlier draft's text first, then ask again for this one.",
          i18n.t("connectors.toolStatus.clipboardBusy")
        );
      }
      // A draft that never opened gives its slots back, so a retry in the
      // same turn isn't refused for text that never reached the clipboard.
      const releaseSlots = (): void => {
        context?.releaseTurnSlot("email_draft");
        if (clipboardReserved) context?.releaseTurnSlot("clipboard");
      };

      // Main may still be resolving policy when the user presses Esc; the
      // cancel names this run so main drops it instead of opening a window.
      const runId = crypto.randomUUID();
      const cancelRun = () =>
        void window.electronAPI?.connectorCancel?.(runId, "cancelled_by_user");
      context?.signal.addEventListener("abort", cancelRun, { once: true });
      // A rejected call (no handler in main) is treated like a missing API.
      const result = await window.electronAPI
        ?.connectorRunDirect?.("email", "draft", { ...draft, clipboardReserved }, runId)
        .catch(() => undefined);
      context?.signal.removeEventListener("abort", cancelRun);
      if (!result) {
        releaseSlots();
        return unavailableResult("connectors_unavailable");
      }
      // Sticky for the turn once text may be on the clipboard, so the answer
      // isn't copied over it.
      const preserveClipboard = (): void => context?.onHoldDelivery({ preserveClipboard: true });
      // An unknown run may have opened a window and used the clipboard, so
      // it keeps its slots.
      if (result.state === "unknown") {
        if (clipboardReserved) preserveClipboard();
        return unknownResult(
          to.join(", "),
          `The draft to ${destination} may or may not have opened. Ask the user to check for a draft window.`,
          i18n.t("connectors.toolStatus.draftUnknown", { destination })
        );
      }
      if (result.state !== "sent") releaseSlots();
      else if (result.copyFailed) context?.releaseTurnSlot("clipboard");
      if (result.state === "not_sent") return notSentResult(result.reason);
      if (result.state === "unavailable") return unavailableResult(result.reason);
      if (result.state === "failed") return failedResult(result.errorCode, result.message);

      const bodyCopied = Boolean(result.bodyCopied);
      const subjectCopied = Boolean(result.subjectCopied);
      if (bodyCopied || subjectCopied) preserveClipboard();

      return {
        success: true,
        data: {
          status: "draft_opened",
          recipients: to,
          bodyCopied,
          subjectCopied,
          guidance: draftOpenedGuidance(result, overflow),
        },
        displayText: i18n.t(
          subjectCopied && bodyCopied
            ? "connectors.toolStatus.draftOpenedSubjectCopied"
            : subjectCopied
              ? "connectors.toolStatus.draftOpenedOnlySubjectCopied"
              : bodyCopied
                ? "connectors.toolStatus.draftOpenedBodyCopied"
                : "connectors.toolStatus.draftOpened",
          { destination }
        ),
      };
    },
  };
}

/**
 * One tool, two paths: with Gmail chosen, a card the user sends from the chat;
 * otherwise a compose window in their email app. gmailSend must never reach
 * buildComposeRequest, which only knows the compose targets.
 */
export function createEmailDraftTool(target: EmailDraftTarget): ToolDefinition {
  return target === "gmailSend" ? createGmailSendTool() : createComposeDraftTool(target);
}

/** Email tools need no login of their own: compose windows, or Gmail's card. */
export const emailToolModule: ConnectorToolModule = {
  connectorId: "email",
  requiresConnection: false,
  createTools: (env) => [findContactTool, createEmailDraftTool(env.emailDraftTarget)],
};
