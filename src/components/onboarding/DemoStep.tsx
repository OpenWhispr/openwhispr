import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import confetti from "canvas-confetti";
import { ChevronDown, CornerDownLeft, Mic, RefreshCw, Sparkles } from "../icons";
import { Button } from "../ui/button";
import { toolIcons } from "../chat/toolIcons";
import { VoicePill, type VoicePillState } from "../dictation/VoicePill";
import { useListeningEntrancePhase } from "../../hooks/useListeningEntrancePhase";
import { resolveListeningEntrancePresentation } from "../../helpers/voicePillPresentation";
import type {
  OnboardingDemoEvent,
  OnboardingDemoKind,
  OnboardingDemoStatus,
} from "../../types/electron";
import founderAvatar from "../../assets/onboarding-founder.webp";
import gmailMark from "../../assets/icons/gmail.svg";

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

// Streaming transcript partials arrive while the microphone is still open.
const isListening = (status: OnboardingDemoStatus | undefined) =>
  status === "listening" || status === "partial";

function DemoVoicePill({
  status,
  getLevel,
  stopLabel,
  onStop,
}: {
  status: OnboardingDemoStatus | undefined;
  getLevel: () => number | null;
  stopLabel: string;
  onStop: () => void;
}) {
  const listening = isListening(status);
  const busy = status === "processing" || status === "replying";
  const phase = useListeningEntrancePhase(listening);
  const entrance = resolveListeningEntrancePresentation({ isRecording: listening, phase });
  // The presentation helper is untyped JS; while listening it always names the
  // recording state.
  const state: VoicePillState = listening ? "recording" : busy ? "processing" : "idle";

  return (
    <VoicePill
      variant="floating"
      state={state}
      expanded={entrance.compactPill || busy}
      collapseToLogo={entrance.collapseToLogo}
      waveformVisible={entrance.waveformVisible}
      horizontalDirection="left"
      getAudioLevel={getLevel}
      role={listening ? "button" : "status"}
      tabIndex={listening ? 0 : undefined}
      aria-label={listening ? stopLabel : undefined}
      title={listening ? stopLabel : undefined}
      onClick={listening ? onStop : undefined}
      onKeyDown={
        listening
          ? (keyEvent) => {
              if (keyEvent.key === "Enter" || keyEvent.key === " ") {
                keyEvent.preventDefault();
                onStop();
              }
            }
          : undefined
      }
      className="shrink-0"
    />
  );
}

function TypingDots() {
  // A 40x20 row of 8px dots on 16px centers (so an 8px gap) in light/text-tertiary.
  return (
    <span className="flex h-5 items-center gap-2">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="onboarding-typing-dot size-1.5 rounded-full bg-[var(--onboarding-text-tertiary)]"
          style={{ animationDelay: `${index * 160}ms` }}
        />
      ))}
    </span>
  );
}

function TypingBubble() {
  const { t } = useTranslation();

  return (
    // Figma "Onboarding / Frame 25": pill on light/surface-stroke, radius 38,
    // 10/20 padding, hugging the dots row.
    <div
      className="flex items-center rounded-[38px] bg-[var(--onboarding-control-border)] px-4 py-2"
      style={BUBBLE_IN}
      aria-label={t("onboarding.rehaul.demo.typing")}
    >
      <TypingDots />
    </div>
  );
}

interface DemoStepProps {
  kind: OnboardingDemoKind;
  firstMessage: string;
  secondMessage: string;
  /** Dictation only; the assistant card uses secondMessage as its placeholder. */
  placeholder?: string;
  listeningLabel: string;
  processingLabel: string;
  stopLabel: string;
  retryLabel: string;
  onSuccessChange: (successful: boolean) => void;
  initialSuccessful?: boolean;
}

export default function DemoStep({
  kind,
  firstMessage,
  secondMessage,
  placeholder = "",
  listeningLabel,
  processingLabel,
  stopLabel,
  retryLabel,
  onSuccessChange,
  initialSuccessful = false,
}: DemoStepProps) {
  const [messageCount, setMessageCount] = useState(0);
  const [event, setEvent] = useState<OnboardingDemoEvent | null>(null);
  const [draft, setDraft] = useState("");
  // Assistant demo only: what the user said, shown above the reply it produced.
  const [transcript, setTranscript] = useState("");
  const [demoId, setDemoId] = useState(() => crypto.randomUUID());
  const [restoredSuccessful, setRestoredSuccessful] = useState(initialSuccessful);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Sampled by the pill's waveform from a rAF loop; a ref keeps the ~12 level
  // events a second from re-rendering the step.
  const levelRef = useRef(0);
  const getLevel = useCallback(() => levelRef.current, []);

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
      if (payload.status === "level") {
        levelRef.current = payload.level ?? 0;
        return;
      }
      if (payload.status === "listening") levelRef.current = 0;
      setRestoredSuccessful(false);
      setEvent(payload);
      if (payload.text) {
        // The assistant demo hears first and writes second: transcript text
        // (live partials, then the final handed to the model) stays out of the
        // reply box, which only ever holds the streamed answer.
        const heard = payload.status === "partial" || payload.status === "processing";
        if (kind === "assistant" && heard) setTranscript(payload.text);
        else setDraft(payload.text);
      }
      if (payload.status === "success") onSuccessChange(true);
    });
    return () => {
      unsubscribe?.();
      void window.electronAPI?.endOnboardingDemo?.(demoId);
    };
  }, [demoId, kind, onSuccessChange]);

  const retry = () => {
    setRestoredSuccessful(false);
    onSuccessChange(false);
    setEvent(null);
    setDraft("");
    setTranscript("");
    setMessageCount(0);
    setDemoId(crypto.randomUUID());
  };

  const effectiveEvent: OnboardingDemoEvent | null = restoredSuccessful
    ? { demoId, kind, status: "success" }
    : event;
  const status = effectiveEvent?.status;
  const successful = status === "success";
  const stop = () => void window.electronAPI?.stopOnboardingDemo?.(demoId);

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
                <div className="flex items-end gap-2.5 ps-11">
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

          {/* A real text box, because that is the habit being taught: click into
              any input, press the shortcut, and the words land there. */}
          {messageCount >= 2 && (
            <VoiceSurface
              inputRef={inputRef}
              value={draft}
              onChange={setDraft}
              placeholder={placeholder}
              event={effectiveEvent}
              getLevel={getLevel}
              listeningLabel={listeningLabel}
              processingLabel={processingLabel}
              stopLabel={stopLabel}
              retryLabel={retryLabel}
              onRetry={retry}
              onStop={stop}
            />
          )}
        </div>
      ) : (
        <EmailThread body={firstMessage}>
          <VoiceSurface
            inputRef={inputRef}
            value={draft}
            onChange={setDraft}
            // Once the request has been heard, the suggestion has done its job.
            placeholder={transcript ? "" : secondMessage}
            event={effectiveEvent}
            transcript={transcript}
            getLevel={getLevel}
            listeningLabel={listeningLabel}
            processingLabel={processingLabel}
            stopLabel={stopLabel}
            retryLabel={retryLabel}
            onRetry={retry}
            onStop={stop}
            embedded
          />
        </EmailThread>
      )}
    </div>
  );
}

/**
 * The assistant demo's stage: one message in a mail client, with the reply
 * composer as the voice surface. The card is what the assistant sees when
 * screen context is on, so the sender's name and the ask are spelled out in
 * plain text rather than baked into artwork.
 */
function EmailThread({ body, children }: { body: string; children: ReactNode }) {
  const { t } = useTranslation();
  const senderName = t("onboarding.rehaul.assistantDemo.email.senderName");

  return (
    <article className="overflow-hidden rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] text-start">
      <header className="flex items-center gap-2.5 border-b border-[var(--onboarding-control-border)] px-4 py-2.5">
        <img
          src={gmailMark}
          alt=""
          aria-hidden="true"
          width={16}
          height={12}
          decoding="async"
          draggable={false}
          className="h-3 w-4 shrink-0 select-none"
        />
        <h2 className="truncate text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)]">
          {t("onboarding.rehaul.assistantDemo.email.subject")}
        </h2>
      </header>

      <div className="flex gap-3 px-4 pb-4 pt-3.5">
        {/* Letter avatar, the way a mail client draws a sender without a photo. */}
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] text-sm font-semibold text-[var(--onboarding-accent)]"
        >
          {senderName.trim().charAt(0)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)]">
            {senderName}
          </p>
          <p className="flex items-center gap-1 text-xs leading-[1.4] text-[var(--onboarding-text-secondary)]">
            {t("onboarding.rehaul.assistantDemo.email.recipient")}
            <ChevronDown className="size-3 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          </p>
          <p className="mt-2.5 whitespace-pre-line text-sm leading-[1.5] text-[var(--onboarding-text-primary)]">
            {body}
          </p>
        </div>
      </div>

      <div
        role="group"
        aria-label={t("onboarding.rehaul.assistantDemo.email.reply")}
        className="flex gap-3 border-t border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface-secondary)] px-4 py-3.5"
      >
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] text-[var(--onboarding-text-secondary)]"
        >
          <CornerDownLeft className="size-4" strokeWidth={1.8} />
        </span>
        {children}
      </div>
    </article>
  );
}

function VoiceSurface({
  inputRef,
  value,
  onChange,
  placeholder,
  event,
  transcript,
  getLevel,
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
  /** What was heard, shown above the reply while the assistant answers it. */
  transcript?: string;
  getLevel: () => number | null;
  listeningLabel: string;
  processingLabel: string;
  stopLabel: string;
  retryLabel: string;
  onRetry: () => void;
  onStop: () => void;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const status = event?.status;
  // The transcript has been handed to the model and no token has landed yet.
  const awaitingReply =
    (status === "processing" || status === "replying") && !!transcript && !value;
  const ToolIcon = event?.tool ? (toolIcons[event.tool] ?? Sparkles) : null;

  return (
    <div
      // Shared by both demos; the assistant variant fills the row beside its avatar.
      className={`relative flex h-36 flex-col rounded-[14px] border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] p-3 ${
        embedded ? "min-w-0 flex-1" : ""
      }`}
    >
      {transcript && (
        <p className="mb-1.5 flex items-start gap-1.5 pe-10 text-xs italic leading-[1.4] text-[var(--onboarding-text-secondary)]">
          <Mic className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span className="line-clamp-2">{transcript}</span>
        </p>
      )}
      {awaitingReply && (
        <span className="mb-1" aria-label={t("onboarding.rehaul.demo.typing")}>
          <TypingDots />
        </span>
      )}
      <textarea
        dir="auto"
        ref={inputRef}
        value={value}
        onChange={(inputEvent) => onChange(inputEvent.target.value)}
        placeholder={placeholder}
        // Placeholder is text-tertiary at 38% — 16/140% in the mail card, 18/140%
        // in the dictation one. The caret takes the brand colour, which is what
        // Figma draws as the 3x18 bar.
        className={`input-inline min-h-0 w-full flex-1 resize-none bg-transparent pe-12 leading-[1.4] text-[var(--onboarding-text-primary)] caret-[var(--onboarding-accent)] outline-none placeholder:text-[color-mix(in_srgb,var(--onboarding-text-tertiary)_38%,transparent)] ${
          embedded ? "text-sm" : "text-base"
        }`}
      />
      {/* Anchored to the corner so the pill grows into the card, leftward. */}
      <div className="absolute bottom-2 end-2 flex justify-end">
        <DemoVoicePill status={status} getLevel={getLevel} stopLabel={stopLabel} onStop={onStop} />
      </div>
      <div
        className="absolute bottom-3 start-3 max-w-[15rem] text-xs text-[var(--onboarding-text-secondary)]"
        aria-live="polite"
      >
        {isListening(status) && listeningLabel}
        {status === "processing" && !transcript && processingLabel}
        {ToolIcon && event?.tool && (
          // The assistant is mid-tool (checking the calendar, say): name it, so
          // the pause reads as work rather than a stall.
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--onboarding-surface-secondary)] px-2 py-1 text-[var(--onboarding-text-primary)]">
            <ToolIcon className="size-3.5 shrink-0" aria-hidden="true" />
            {t(`agentMode.tools.${event.tool}Status`, {
              defaultValue: t(`agentMode.tools.${event.tool}Name`, { defaultValue: event.tool }),
            })}
          </span>
        )}
        {status === "error" && (
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
