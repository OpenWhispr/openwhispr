import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, RefreshCw, UserRound } from "lucide-react";
import { Button } from "../ui/button";
import type { OnboardingDemoEvent, OnboardingDemoKind } from "../../types/electron";

function ConfettiLayer() {
  const colors = ["bg-blue-500", "bg-emerald-500", "bg-amber-400", "bg-cyan-400", "bg-fuchsia-600"];
  return (
    <div className="pointer-events-none fixed inset-0 z-20 overflow-hidden" aria-hidden="true">
      {Array.from({ length: 48 }, (_, index) => (
        <span
          key={index}
          className={`onboarding-confetti-piece absolute -top-8 rounded-sm ${
            index % 13 === 0
              ? "h-9 w-24 blur-sm"
              : index % 7 === 0
                ? "h-6 w-3"
                : index % 4 === 0
                  ? "h-4 w-2"
                  : index % 3 === 0
                    ? "h-2 w-6"
                    : "h-3 w-1.5"
          } ${colors[index % colors.length]}`}
          style={{
            left: `${2 + ((index * 29) % 96)}%`,
            animationDelay: `${(index % 9) * 55}ms`,
            animationDuration: `${2200 + (index % 6) * 110}ms`,
          }}
        />
      ))}
    </div>
  );
}

function FounderAvatar() {
  return (
    <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white bg-gradient-to-br from-amber-200 via-blue-200 to-blue-600 text-blue-950 shadow-sm">
      <UserRound className="mt-1 size-6" strokeWidth={1.7} />
    </div>
  );
}

function TypingBubble() {
  return (
    <div
      className="flex h-8 w-16 items-center justify-center gap-1.5 rounded-full bg-neutral-200"
      aria-label="Typing"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 rounded-full bg-neutral-400 motion-safe:animate-pulse"
          style={{ animationDelay: `${index * 130}ms` }}
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
    const first = window.setTimeout(() => setMessageCount(1), 650);
    const second = window.setTimeout(() => setMessageCount(2), 1400);
    const input = window.setTimeout(() => inputRef.current?.focus(), 1550);
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
    <div className="relative mx-auto mt-8 w-full max-w-[26.5rem]">
      {successful && <ConfettiLayer />}

      {kind === "dictation" ? (
        <div className="space-y-2">
          {messageCount === 0 ? (
            <div className="flex items-center gap-2">
              <FounderAvatar />
              <TypingBubble />
            </div>
          ) : (
            <>
              <p className="ml-auto w-fit rounded-full bg-blue-500 px-4 py-2 text-sm text-white">
                {firstMessage}
              </p>
              <div className="flex items-center gap-2">
                <FounderAvatar />
                {messageCount === 1 ? (
                  <TypingBubble />
                ) : (
                  <p className="w-fit rounded-full bg-blue-500 px-4 py-2 text-sm text-white">
                    {secondMessage}
                  </p>
                )}
              </div>
            </>
          )}

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
        <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-lg md:p-8">
          <div className="flex items-center gap-3 border-b border-neutral-200 pb-4">
            <div className="flex size-10 items-center justify-center rounded-full bg-violet-100 font-medium text-violet-600">
              E
            </div>
            <div>
              <p className="text-sm font-medium text-neutral-950">Eren Lauren</p>
              <p className="text-xs text-neutral-500">to you</p>
            </div>
          </div>
          <p className="py-5 text-sm leading-6 text-neutral-950">{firstMessage}</p>
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
    <div className="relative mt-8 min-h-36 rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
      <textarea
        ref={inputRef}
        value={value}
        onChange={(inputEvent) => onChange(inputEvent.target.value)}
        placeholder={placeholder}
        className="input-inline min-h-28 w-full resize-none bg-transparent pr-10 text-sm leading-5 text-neutral-950 outline-none placeholder:text-neutral-300"
      />
      <div className="absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-full bg-neutral-950 text-white">
        {event?.status === "processing" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Mic className={`size-4 ${event?.status === "listening" ? "animate-pulse" : ""}`} />
        )}
      </div>
      <div
        className="absolute bottom-3 left-3 max-w-[15rem] text-xs text-neutral-500"
        aria-live="polite"
      >
        {event?.status === "listening" && listeningLabel}
        {event?.status === "processing" && processingLabel}
        {event?.status === "error" && (
          <span className="inline-flex items-center gap-1 text-red-500">
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
