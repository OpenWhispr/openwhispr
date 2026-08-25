import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CircleAlert, Loader2, Mail, Send } from "lucide-react";
import { cn } from "../lib/utils";
import { EMAIL_REGEX } from "../../utils/validation";
import { parseRecipients, type EmailDraftCardData } from "./emailDrafts";

type SendState = "draft" | "sending" | "sent" | "failed";

function FieldRow({
  label,
  value,
  onChange,
  disabled,
  emphasized,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  disabled: boolean;
  emphasized?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 px-2.5 py-1.5 border-b border-border/10">
      <span className="w-11 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/50">
        {label}
      </span>
      {onChange ? (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          className={cn(
            "flex-1 min-w-0 bg-transparent text-[12px] text-foreground rounded-sm",
            emphasized && "font-medium",
            "placeholder:text-muted-foreground/40",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
            "disabled:text-muted-foreground/60"
          )}
        />
      ) : (
        <span
          className={cn(
            "flex-1 min-w-0 text-[12px] text-muted-foreground truncate",
            emphasized && "font-medium text-foreground"
          )}
        >
          {value}
        </span>
      )}
    </div>
  );
}

export function EmailDraftCard({ draft }: { draft: EmailDraftCardData }) {
  const { t } = useTranslation();
  const [to, setTo] = useState(draft.to.join(", "));
  const [cc, setCc] = useState(draft.cc.join(", "));
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [sendState, setSendState] = useState<SendState>(draft.sent ? "sent" : "draft");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const isSent = sendState === "sent";
  const isSending = sendState === "sending";
  const showCc = draft.cc.length > 0 || cc.trim().length > 0;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [body, isSent]);

  const handleSend = async () => {
    const toList = parseRecipients(to);
    const ccList = parseRecipients(cc);
    if (toList.length === 0 || [...toList, ...ccList].some((a) => !EMAIL_REGEX.test(a))) {
      setErrorKey("agentMode.emailDraft.invalidRecipients");
      return;
    }

    setErrorKey(null);
    setSendState("sending");
    const result = await window.electronAPI?.gmailSendEmail?.({
      to: toList,
      cc: ccList.length ? ccList : undefined,
      subject,
      body,
    });
    if (result?.success) {
      setSendState("sent");
      window.electronAPI?.updateAgentToolCall?.(draft.callId, {
        to: toList,
        cc: ccList,
        subject,
        body,
        status: "sent",
      });
    } else {
      setSendState("failed");
      setErrorKey("agentMode.emailDraft.sendFailed");
    }
  };

  return (
    <div className="mt-2 rounded-md border border-border/30 bg-surface-1/80 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border/15 bg-surface-1">
        <Mail size={12} className={cn(isSent ? "text-emerald-500/70" : "text-primary/70")} />
        <span className="text-[11px] font-medium text-foreground">
          {t("agentMode.emailDraft.title")}
        </span>
        {draft.from && (
          <span className="ml-auto text-[10px] text-muted-foreground/50 truncate">
            {t("agentMode.emailDraft.via", { email: draft.from })}
          </span>
        )}
      </div>

      <FieldRow
        label={t("agentMode.emailDraft.to")}
        value={isSent ? parseRecipients(to).join(", ") : to}
        onChange={isSent ? undefined : setTo}
        disabled={isSending}
      />
      {showCc && (
        <FieldRow
          label={t("agentMode.emailDraft.cc")}
          value={isSent ? parseRecipients(cc).join(", ") : cc}
          onChange={isSent ? undefined : setCc}
          disabled={isSending}
        />
      )}
      <FieldRow
        label={t("agentMode.emailDraft.subject")}
        value={subject}
        onChange={isSent ? undefined : setSubject}
        disabled={isSending}
        emphasized
      />

      {isSent ? (
        <p className="px-2.5 py-2 text-[12px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {body}
        </p>
      ) : (
        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={isSending}
          spellCheck={false}
          className={cn(
            "block w-full px-2.5 py-2 bg-transparent resize-none",
            "text-[12px] leading-relaxed text-foreground",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 rounded-sm",
            "disabled:text-muted-foreground/60"
          )}
        />
      )}

      <div className="flex items-center gap-2 px-2.5 py-1.5 border-t border-border/15">
        {isSent ? (
          <div className="flex items-center gap-1">
            <Check
              size={11}
              className="text-emerald-500 shrink-0"
              style={{ animation: "tool-check-pop 300ms ease-out both" }}
            />
            <span className="text-[11px] text-emerald-600 dark:text-emerald-400/80">
              {t("agentMode.emailDraft.sent")}
            </span>
          </div>
        ) : (
          <>
            {errorKey && (
              <div className="flex items-center gap-1 min-w-0">
                <CircleAlert size={10} className="text-destructive/60 shrink-0" />
                <span className="text-[10px] text-destructive/70 truncate">{t(errorKey)}</span>
              </div>
            )}
            <button
              onClick={handleSend}
              disabled={isSending}
              className={cn(
                "ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md shrink-0",
                "bg-primary/90 text-primary-foreground text-[11px] font-medium",
                "hover:bg-primary active:scale-[0.98] transition-all duration-150",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40",
                "disabled:bg-primary/50 disabled:cursor-default"
              )}
            >
              {isSending ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Send size={11} />
              )}
              {isSending
                ? t("agentMode.emailDraft.sending")
                : sendState === "failed"
                  ? t("agentMode.emailDraft.retry")
                  : t("agentMode.emailDraft.send")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
