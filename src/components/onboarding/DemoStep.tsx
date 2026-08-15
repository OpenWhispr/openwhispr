import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import type { OnboardingDemoEvent, OnboardingDemoKind } from "../../types/electron";

function ConfettiLayer() {
  const colors = ["bg-primary", "bg-success", "bg-warning", "bg-info"];
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {Array.from({ length: 28 }, (_, index) => (
        <span
          key={index}
          className={`onboarding-confetti-piece absolute top-0 size-2 rounded-sm ${colors[index % colors.length]}`}
          style={{
            left: `${4 + ((index * 37) % 92)}%`,
            animationDelay: `${(index % 7) * 70}ms`,
          }}
        />
      ))}
    </div>
  );
}

interface DemoStepProps {
  kind: OnboardingDemoKind;
  firstMessage: string;
  secondMessage: string;
  placeholder: string;
  listeningLabel: string;
  processingLabel: string;
  retryLabel: string;
  assistantResponse?: string;
  onSuccessChange: (successful: boolean) => void;
}

export default function DemoStep({
  kind,
  firstMessage,
  secondMessage,
  placeholder,
  listeningLabel,
  processingLabel,
  retryLabel,
  assistantResponse,
  onSuccessChange,
}: DemoStepProps) {
  const [messageCount, setMessageCount] = useState(0);
  const [event, setEvent] = useState<OnboardingDemoEvent | null>(null);
  const [draft, setDraft] = useState("");
  const [demoId, setDemoId] = useState(() => crypto.randomUUID());
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const first = window.setTimeout(() => setMessageCount(1), 550);
    const second = window.setTimeout(() => setMessageCount(2), 1300);
    const input = window.setTimeout(() => inputRef.current?.focus(), 1500);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
      window.clearTimeout(input);
    };
  }, [demoId]);

  useEffect(() => {
    void window.electronAPI?.beginOnboardingDemo?.({ id: demoId, kind });
    const unsubscribe = window.electronAPI?.onOnboardingDemoEvent?.((payload) => {
      if (payload.demoId !== demoId || payload.kind !== kind) return;
      setEvent(payload);
      if (payload.text) setDraft(payload.text);
      if (payload.status === "success") onSuccessChange(true);
    });
    return () => {
      unsubscribe?.();
      void window.electronAPI?.endOnboardingDemo?.(demoId);
    };
  }, [demoId, kind, onSuccessChange]);

  const retry = () => {
    onSuccessChange(false);
    setEvent(null);
    setDraft("");
    setMessageCount(0);
    setDemoId(crypto.randomUUID());
  };

  const status = event?.status;
  const successful = status === "success";

  return (
    <div className="relative mx-auto mt-8 w-full max-w-4xl">
      {successful && <ConfettiLayer />}

      {kind === "dictation" ? (
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 font-medium text-primary">
              G
            </div>
            <div className="space-y-2">
              {messageCount === 0 && (
                <div className="w-fit rounded-2xl rounded-tl-sm bg-muted px-4 py-2 text-muted-foreground">
                  •••
                </div>
              )}
              {messageCount >= 1 && (
                <p className="w-fit rounded-2xl rounded-tl-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
                  {firstMessage}
                </p>
              )}
              {messageCount >= 2 && (
                <p className="w-fit rounded-2xl rounded-tl-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
                  {secondMessage}
                </p>
              )}
            </div>
          </div>

          {messageCount >= 2 && (
            <VoiceSurface
              inputRef={inputRef}
              value={draft}
              onChange={setDraft}
              placeholder={placeholder}
              event={event}
              listeningLabel={listeningLabel}
              processingLabel={processingLabel}
              retryLabel={retryLabel}
              onRetry={retry}
            />
          )}
        </div>
      ) : (
        <div className="rounded-3xl border border-border bg-card p-6 shadow-lg md:p-8">
          <div className="flex items-center gap-3 border-b border-border pb-4">
            <div className="flex size-10 items-center justify-center rounded-full bg-accent/15 font-medium text-accent">
              E
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Eren Lauren</p>
              <p className="text-xs text-muted-foreground">to you</p>
            </div>
          </div>
          <p className="py-5 text-sm leading-6 text-foreground">{firstMessage}</p>
          <VoiceSurface
            inputRef={inputRef}
            value={draft || (successful ? (assistantResponse ?? "") : "")}
            onChange={setDraft}
            placeholder={secondMessage}
            event={event}
            listeningLabel={listeningLabel}
            processingLabel={processingLabel}
            retryLabel={retryLabel}
            onRetry={retry}
          />
        </div>
      )}
    </div>
  );
}

function VoiceSurface({
  inputRef,
  value,
  onChange,
  placeholder,
  event,
  listeningLabel,
  processingLabel,
  retryLabel,
  onRetry,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  event: OnboardingDemoEvent | null;
  listeningLabel: string;
  processingLabel: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div className="relative rounded-2xl border border-border bg-background p-4 shadow-sm">
      <textarea
        ref={inputRef}
        value={value}
        onChange={(inputEvent) => onChange(inputEvent.target.value)}
        placeholder={placeholder}
        className="min-h-32 w-full resize-none bg-transparent pr-12 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div className="absolute bottom-4 right-4 flex size-10 items-center justify-center rounded-full bg-foreground text-background">
        {event?.status === "processing" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Mic className={`size-4 ${event?.status === "listening" ? "animate-pulse" : ""}`} />
        )}
      </div>
      <div className="mt-2 min-h-5 text-xs text-muted-foreground" aria-live="polite">
        {event?.status === "listening" && listeningLabel}
        {event?.status === "processing" && processingLabel}
        {event?.status === "partial" && event.text}
        {event?.status === "error" && (
          <span className="inline-flex items-center gap-2 text-destructive">
            {event.message}
            <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
              <RefreshCw className="size-3" />
              {retryLabel}
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
