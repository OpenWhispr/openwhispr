import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import confetti from "canvas-confetti";
import { ChevronDown, Loader2, Mic, RefreshCw, Square } from "lucide-react";
import { Button } from "../ui/button";
import type { OnboardingDemoEvent, OnboardingDemoKind } from "../../types/electron";
import founderAvatar from "../../assets/onboarding-founder.webp";
import emailSenderAvatar from "../../assets/onboarding-email-sender.webp";
import assistantAvatar from "../../assets/onboarding-assistant-dog.webp";

/**
 * The dictation success celebration: canvas-confetti's "school pride" effect —
 * two cannons firing continuously from the left and right edges while the middle
 * of the screen stays readable.
 *
 * Differences from the upstream demo, all deliberate. It runs for under two
 * seconds instead of thirty, because this fires on a success state and not a
 * permanent page decoration. The per-frame particle count tapers with the
 * remaining time so the streams thin out instead of stopping mid-air. The loop is
 * cancelled on unmount — the demo is a bare IIFE with no teardown, which in React
 * would keep firing into a detached canvas. And reduced motion skips the loop
 * outright rather than scheduling ~100 frames of no-ops.
 *
 * Colours are sampled from the reference artwork; `scalar` sizes the pieces (1 is
 * canvas-confetti's default).
 */
const CONFETTI_BASE = {
  // Sampled from the reference artwork: gold and yellow through orange, then teal,
  // blue, magenta, purple and green.
  colors: [
    "#f5d400",
    "#f5c518",
    "#f07800",
    "#f04800",
    "#00d0bc",
    "#2e6be6",
    "#d8005f",
    "#8e1a78",
    "#5fa82a",
  ],
  shapes: ["circle", "square"] as ("circle" | "square")[],
  scalar: 1.3,
  spread: 55,
  startVelocity: 45,
  gravity: 1,
  decay: 0.9,
  ticks: 200,
  // canvas-confetti opts out natively; the CSS in index.css cannot reach a canvas.
  disableForReducedMotion: true,
};

/** Long enough to register as a celebration, short enough not to be decoration. */
const STREAM_DURATION_MS = 1800;
/** Per side, per frame, at full strength; tapers to 1 as the streams wind down. */
const STREAM_PARTICLES = 7;

function ConfettiLayer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // useWorker: false on purpose. The worker path hands the canvas to an
    // OffscreenCanvas, which can only be transferred once, and StrictMode mounts
    // effects twice in dev — the second pass throws. ~90 particles for 1.5s on the
    // main thread costs nothing next to that.
    const fire = confetti.create(canvas, { resize: true, useWorker: false });

    // canvas-confetti already no-ops per call under reduced motion, but bail
    // before the loop so we don't schedule ~100 frames of nothing.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const end = performance.now() + STREAM_DURATION_MS;
    let frameId = 0;

    const frame = (now: number) => {
      const remaining = Math.max(0, (end - now) / STREAM_DURATION_MS);
      const shared = {
        ...CONFETTI_BASE,
        particleCount: Math.max(1, Math.round(STREAM_PARTICLES * remaining)),
      };
      // 60 from the left edge and 120 from the right both angle inward and up.
      void fire({ ...shared, angle: 60, origin: { x: 0 } });
      void fire({ ...shared, angle: 120, origin: { x: 1 } });
      if (now < end) frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(frameId);
      fire.reset();
    };
  }, []);

  // Escape the transformed onboarding step so the fixed canvas spans the full
  // window and particles can fall naturally past the panel's bottom edge.
  return createPortal(
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-20 h-full w-full"
      aria-hidden="true"
    />,
    document.body
  );
}

// Figma "Frame 26": 40px round avatar, bottom-aligned with the bubble beside it.
function FounderAvatar() {
  return (
    <img
      src={founderAvatar}
      // Decorative: the demo conversation never names the sender, so a
      // descriptive alt would announce a person the transcript doesn't mention.
      alt=""
      aria-hidden="true"
      width={40}
      height={40}
      decoding="async"
      draggable={false}
      className="size-9 shrink-0 rounded-full object-cover"
    />
  );
}

// Figma "Frame 25"/"Frame 27": pill on surface/brand, radius 38, 10/20 padding,
// Inter Medium 14/140% in light/surface-primary.
function FounderBubble({ children }: { children: ReactNode }) {
  return (
    <p
      className="w-fit rounded-[38px] bg-[var(--onboarding-accent)] px-4 py-2 text-sm font-medium leading-[1.4] text-[var(--onboarding-accent-foreground)]"
      style={BUBBLE_IN}
    >
      {children}
    </p>
  );
}

// The keyframe the chat surfaces already use for message entry (ChatMessage.tsx,
// MeetingTranscriptChat.tsx), so the demo bubbles land with the app's one bubble
// motion instead of a second dialect. The global prefers-reduced-motion block in
// index.css clamps the duration, and `both` leaves the bubble visible either way.
const BUBBLE_IN = { animation: "agent-message-in 220ms ease-out both" } as const;

function TypingBubble() {
  const { t } = useTranslation();

  return (
    // Figma "Onboarding / Frame 25": pill on light/surface-stroke, radius 38,
    // 10/20 padding, hugging a 40x20 row of 8px dots on 16px centers (so an 8px
    // gap) in light/text-tertiary.
    <div
      className="flex items-center rounded-[38px] bg-[var(--onboarding-control-border)] px-4 py-2"
      style={BUBBLE_IN}
      aria-label={t("onboarding.rehaul.demo.typing")}
    >
      <span className="flex h-5 items-center gap-2">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="onboarding-typing-dot size-1.5 rounded-full bg-[var(--onboarding-text-tertiary)]"
            style={{ animationDelay: `${index * 160}ms` }}
          />
        ))}
      </span>
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
  stopLabel: string;
  retryLabel: string;
  assistantResponse?: string;
  assistantSenderName?: string;
  assistantSenderEmail?: string;
  assistantRecipientLabel?: string;
  onSuccessChange: (successful: boolean) => void;
}

export default function DemoStep({
  kind,
  firstMessage,
  secondMessage,
  placeholder,
  listeningLabel,
  processingLabel,
  stopLabel,
  retryLabel,
  assistantResponse,
  assistantSenderName,
  assistantSenderEmail,
  assistantRecipientLabel,
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
    <div
      // One compact width for both demos keeps the two steps from stepping in
      // and out as the flow moves between them.
      className="relative mx-auto mt-6 w-full max-w-lg"
    >
      {successful && kind === "dictation" && <ConfettiLayer />}

      {kind === "dictation" ? (
        // Frame 2147258978: 40 between the bubbles and the card. Explicit gaps
        // rather than space-y so the card's spacing can't collide with the
        // 12 that separates the two bubble rows.
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            {messageCount === 0 ? (
              <div className="flex items-end gap-2.5">
                <FounderAvatar />
                <TypingBubble />
              </div>
            ) : (
              <>
                {/* Frame 32: the first bubble carries the avatar gutter as padding
                    (40 avatar + 10 gap) so both messages share one left edge and
                    the avatar rides the newest row. */}
                <div className="flex items-end gap-2.5 pl-11">
                  <FounderBubble>{firstMessage}</FounderBubble>
                </div>
                {/* Frame 33 */}
                <div className="flex items-end gap-2.5">
                  <FounderAvatar />
                  {messageCount === 1 ? (
                    <TypingBubble />
                  ) : (
                    <FounderBubble>{secondMessage}</FounderBubble>
                  )}
                </div>
              </>
            )}
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
              stopLabel={stopLabel}
              retryLabel={retryLabel}
              onRetry={retry}
              onStop={() => void window.electronAPI?.stopOnboardingDemo?.(demoId)}
            />
          )}
        </div>
      ) : (
        // No shadow: the tokenized stroke carries the edge of the compact card.
        <article className="flex h-[340px] flex-col gap-5 rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-4 text-left">
          {/* Frame 2147259013: 44px avatar, 16 gap, and a column that keeps the
              body copy on the text's left edge rather than the avatar's. */}
          <div className="flex gap-3">
            <img
              src={emailSenderAvatar}
              alt=""
              aria-hidden="true"
              width={44}
              height={44}
              decoding="async"
              draggable={false}
              className="size-10 shrink-0 rounded-full object-cover"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              <div className="flex flex-col gap-1">
                <p className="flex min-w-0 gap-1 text-sm leading-[1.4]">
                  <span className="font-medium text-[var(--onboarding-text-primary)]">
                    {assistantSenderName}
                  </span>
                  <span className="truncate text-[var(--onboarding-text-secondary)]">
                    &lt;{assistantSenderEmail}&gt;
                  </span>
                </p>
                <p className="flex items-center gap-[5px] text-sm leading-[1.4] text-[var(--onboarding-text-secondary)]">
                  {assistantRecipientLabel}
                  <ChevronDown
                    className="size-4 shrink-0 text-[var(--onboarding-text-primary)]"
                    strokeWidth={1.333}
                  />
                </p>
              </div>
              <p className="text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)]">
                {firstMessage}
              </p>
            </div>
          </div>

          {/* Frame 2147259014: the reply row repeats the 44px avatar and 16 gap so
              the input card lines up with the mail body above it. */}
          <div className="flex gap-3">
            <img
              src={assistantAvatar}
              alt=""
              aria-hidden="true"
              width={44}
              height={44}
              decoding="async"
              draggable={false}
              className="size-10 shrink-0 rounded-full object-cover"
            />
            <VoiceSurface
              inputRef={inputRef}
              value={draft || (successful ? (assistantResponse ?? "") : "")}
              onChange={setDraft}
              placeholder={secondMessage}
              event={event}
              listeningLabel={listeningLabel}
              processingLabel={processingLabel}
              stopLabel={stopLabel}
              retryLabel={retryLabel}
              onRetry={retry}
              onStop={() => void window.electronAPI?.stopOnboardingDemo?.(demoId)}
              embedded
            />
          </div>
        </article>
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
  stopLabel,
  retryLabel,
  onRetry,
  onStop,
  embedded = false,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  event: OnboardingDemoEvent | null;
  listeningLabel: string;
  processingLabel: string;
  stopLabel: string;
  retryLabel: string;
  onRetry: () => void;
  onStop: () => void;
  embedded?: boolean;
}) {
  return (
    <div
      // Shared by both demos; the assistant variant fills the row beside its avatar.
      className={`relative flex h-36 flex-col rounded-[14px] border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] p-3 ${
        embedded ? "min-w-0 flex-1" : ""
      }`}
    >
      <textarea
        ref={inputRef}
        value={value}
        onChange={(inputEvent) => onChange(inputEvent.target.value)}
        placeholder={placeholder}
        // Placeholder is text-tertiary at 38% — 16/140% in the mail card, 18/140%
        // in the dictation one. The caret takes the brand colour, which is what
        // Figma draws as the 3x18 bar.
        className={`input-inline min-h-0 w-full flex-1 resize-none bg-transparent pr-10 leading-[1.4] text-[var(--onboarding-text-primary)] caret-[var(--onboarding-accent)] outline-none placeholder:text-[color-mix(in_srgb,var(--onboarding-text-tertiary)_38%,transparent)] ${
          embedded ? "text-sm" : "text-base"
        }`}
      />
      <button
        type="button"
        disabled={event?.status !== "listening"}
        onClick={onStop}
        aria-label={stopLabel}
        title={event?.status === "listening" ? stopLabel : undefined}
        // Figma places the 32px control 10 from the card's bottom-right corner.
        className="absolute bottom-2.5 right-2.5 flex size-8 items-center justify-center rounded-full border border-[var(--onboarding-control-border)] bg-[var(--onboarding-inverse-surface)] text-[var(--onboarding-inverse-text)] transition-colors hover:bg-[var(--onboarding-inverse-surface-secondary)] disabled:cursor-default disabled:hover:bg-[var(--onboarding-inverse-surface)]"
      >
        {event?.status === "processing" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : event?.status === "listening" ? (
          <Square className="size-3.5 fill-current" />
        ) : (
          <Mic className="size-4" />
        )}
      </button>
      <div
        className="absolute bottom-3 left-3 max-w-[15rem] text-xs text-[var(--onboarding-text-secondary)]"
        aria-live="polite"
      >
        {event?.status === "listening" && listeningLabel}
        {event?.status === "processing" && processingLabel}
        {event?.status === "error" && (
          <span className="inline-flex items-center gap-1 text-[var(--onboarding-danger)]">
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
