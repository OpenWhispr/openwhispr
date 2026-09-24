import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSettings, useSettingsStore } from "../stores/settingsStore";
import logger from "../utils/logger";
import { createSpeechChunker } from "../services/voice/speechChunker";
import { createPcmPlayer, type PcmPlayer } from "../services/voice/pcmPlayer";
import { startMicStream, type MicStream } from "../services/voice/micStream";
import type {
  AssistantSpeechTap,
  VoiceConversationEvent,
  VoiceTurnEndpoint,
} from "../services/voice/types";
import { shouldStopForIdle, voiceToolFiller } from "../services/voice/voiceTools";
import { resolveChatStreamingInference } from "../helpers/dictationAgentInference.js";

export type VoiceConversationState = "off" | "starting" | "listening" | "thinking" | "speaking";

interface VoiceConversationOptions {
  /** Sends a finished spoken turn into the assistant panel. */
  onUserTurn: (text: string) => void;
  onError?: (message: string) => void;
}

interface TurnMetrics {
  endedAt: number;
  endpoint: VoiceTurnEndpoint | null;
  speechMs: number;
  sttMs: number;
  transcriptAt: number;
  firstDeltaAt?: number;
  firstChunkSentAt?: number;
  firstAudioAt?: number;
  /** First chunk only: waiting in the worker's TTS queue, then generating to first audio. */
  ttsQueueWaitMs?: number | null;
  ttsGenerateMs?: number | null;
  chunks: number;
  /** For the harness report. */
  transcript: string;
  calledTools: string[];
  availableTools: string[];
  /** Write tools that ran and succeeded this turn (createWriteOnceGuard caps each at one). */
  succeededWrites: string[];
  answer: string;
}

const DEFAULT_PARAKEET_MODEL = "parakeet-unified-en-0.6b";
// Spoken replies stop after three sentences; the panel keeps the full answer. Doing
// this in code, not the prompt: brevity pressure in the prompt made the model skip tools.
const MAX_SPOKEN_SENTENCES = 3;
// Hands-free sessions end after 2.5 minutes with no speech in either direction.
const IDLE_STOP_MS = 150_000;
const SESSION_TICK_MS = 10_000;
// Re-warm the voice model every minute, well inside llama-server's 5-minute idle stop.
const KEEP_WARM_TICKS = 6;

const since = (from: number, to: number | undefined) =>
  to === undefined ? null : Math.round(to - from);

const READINESS_MESSAGE_KEYS = {
  "language-unsupported": "voiceConversation.errors.languageUnsupported",
  "voice-models-missing": "voiceConversation.errors.voiceModelsMissing",
  "speech-model-missing": "voiceConversation.errors.speechModelMissing",
  "brain-not-downloaded": "voiceConversation.errors.brainNotDownloaded",
} as const;

/**
 * The { mode, model } sent to getReadiness and used to decide which local model (if
 * any) to keep warm. The harness's brain override always wins and is itself local;
 * otherwise this mirrors whichever brain resolveChatStreamingInference resolved.
 * `mode`, not `provider`, says "local" — in local inference mode `provider` is the
 * model family (e.g. "qwen", "gemma"), never the literal string "local".
 */
function resolveVoiceBrain(
  voiceModel: { mode?: string; model?: string },
  brainOverride: string | null
): { mode: string; model: string } {
  if (brainOverride) return { mode: "local", model: brainOverride };
  return { mode: voiceModel.mode || "", model: voiceModel.model || "" };
}

/**
 * Hands-free local voice conversation: an always-listening loop that turns each VAD
 * turn into an assistant command and speaks the streamed answer back, with barge-in.
 * Enabled by the voiceConversationEnabled setting.
 */
export function useVoiceConversation({ onUserTurn, onError }: VoiceConversationOptions) {
  const { t } = useTranslation();
  const [state, setState] = useState<VoiceConversationState>("off");
  const activeRef = useRef(false);
  const micRef = useRef<MicStream | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const chunkerRef = useRef(createSpeechChunker({ maxChunks: MAX_SPOKEN_SENTENCES }));
  const utteranceRef = useRef<string | null>(null);
  const responseDoneRef = useRef(false);
  const chunkIndexRef = useRef(0);
  const pendingSpeaksRef = useRef(0);
  const harnessRef = useRef(false);
  const [harnessAvailable, setHarnessAvailable] = useState(false);
  const [harnessActive, setHarnessActive] = useState(false);
  const [brainOverride, setBrainOverride] = useState<string | null>(null);
  const lastActivityRef = useRef(0);
  const sessionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const turnRef = useRef<TurnMetrics | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const onUserTurnRef = useRef(onUserTurn);
  onUserTurnRef.current = onUserTurn;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const api = window.electronAPI?.voiceConversation;

  const settingEnabled = useSettingsStore((state) => state.voiceConversationEnabled);
  // The harness runs without the setting so comparisons never depend on user settings.
  const enabled = settingEnabled || harnessAvailable;

  useEffect(() => {
    void api
      ?.isHarness()
      .then((value: boolean) => setHarnessAvailable(Boolean(value)))
      .catch(() => {});
    void api
      ?.brainOverride()
      .then((value: string | null) => setBrainOverride(value || null))
      .catch(() => {});
  }, [api]);

  const logTurn = useCallback((outcome: string) => {
    const turn = turnRef.current;
    if (!turn) return;
    turnRef.current = null;
    const metrics = {
      speechMs: turn.speechMs,
      sttMs: turn.sttMs,
      transcriptToFirstDeltaMs: since(turn.transcriptAt, turn.firstDeltaAt),
      firstDeltaToFirstChunkMs: turn.firstDeltaAt
        ? since(turn.firstDeltaAt, turn.firstChunkSentAt)
        : null,
      firstChunkToFirstAudioMs: turn.firstChunkSentAt
        ? since(turn.firstChunkSentAt, turn.firstAudioAt)
        : null,
      speechEndToFirstAudioMs: since(turn.endedAt, turn.firstAudioAt),
      // Adds the end-of-turn wait, which speechEndToFirstAudioMs starts after.
      userStopToFirstAudioMs:
        turn.endpoint && turn.firstAudioAt !== undefined
          ? turn.endpoint.endpointMs + Math.round(turn.firstAudioAt - turn.endedAt)
          : null,
      endpointMs: turn.endpoint?.endpointMs ?? null,
      endpointProbability: turn.endpoint?.probability ?? null,
      endpointSegments: turn.endpoint?.segments ?? null,
      smartTurnFeatureMs: turn.endpoint?.featureMs ?? null,
      smartTurnInferenceMs: turn.endpoint?.inferenceMs ?? null,
      ttsQueueWaitMs: turn.ttsQueueWaitMs ?? null,
      ttsGenerateMs: turn.ttsGenerateMs ?? null,
      chunks: turn.chunks,
    };
    const endpointReason = turn.endpoint?.reason ?? null;
    logger.info("Voice conversation turn", { outcome, endpointReason, ...metrics }, "voice-conversation");
    if (harnessRef.current) {
      window.electronAPI?.voiceConversation?.reportTurn({
        outcome,
        transcript: turn.transcript,
        calledTools: turn.calledTools,
        availableTools: turn.availableTools,
        answer: turn.answer,
        metrics,
      });
    }
  }, []);

  // A turn ends only when the answer is complete, every chunk is synthesized and
  // playback has drained; a gap between two chunks' audio must not end it early.
  const finishUtteranceIfDrained = useCallback(() => {
    if (!utteranceRef.current || !responseDoneRef.current) return;
    if (pendingSpeaksRef.current > 0 || playerRef.current?.isPlaying()) return;
    utteranceRef.current = null;
    logTurn(chunkIndexRef.current === 0 ? "empty" : "spoke");
  }, [logTurn]);

  const speakChunk = useCallback(
    (text: string) => {
      const utteranceId = utteranceRef.current;
      if (!utteranceId || !api) return;
      const turn = turnRef.current;
      if (turn) {
        turn.firstChunkSentAt ??= Date.now();
        turn.chunks += 1;
      }
      const chunkIndex = chunkIndexRef.current++;
      pendingSpeaksRef.current += 1;
      void api
        .speak({ utteranceId, chunkIndex, text })
        .then((result) => {
          if (chunkIndex === 0 && turn && turnRef.current === turn) {
            turn.ttsQueueWaitMs = result?.queueWaitMs ?? null;
            turn.ttsGenerateMs = result?.firstAudioMs ?? null;
          }
        })
        .catch((error: Error) => {
          logger.warn("Voice conversation TTS failed", { error: error.message }, "voice-conversation");
        })
        .finally(() => {
          pendingSpeaksRef.current -= 1;
          if (utteranceRef.current === utteranceId) finishUtteranceIfDrained();
        });
    },
    [api, finishUtteranceIfDrained]
  );

  const bargeIn = useCallback(() => {
    const utteranceId = utteranceRef.current;
    utteranceRef.current = null;
    chunkerRef.current.reset();
    playerRef.current?.flush();
    if (utteranceId) {
      if (harnessRef.current) api?.reportTurnEvent({ type: "flushed", at: Date.now() });
      if (!responseDoneRef.current) cancelRef.current?.();
      void api?.cancelSpeech(utteranceId);
      logTurn("barge-in");
    }
  }, [api, logTurn]);

  const handleEvent = useCallback(
    (event: VoiceConversationEvent) => {
      if (!activeRef.current) return;
      if (event.type !== "error") lastActivityRef.current = Date.now();
      if (event.type === "speech-start") {
        if (utteranceRef.current) bargeIn();
        setState("listening");
      } else if (event.type === "transcript") {
        if (!event.text) return;
        if (utteranceRef.current) bargeIn();
        utteranceRef.current = crypto.randomUUID();
        responseDoneRef.current = false;
        chunkIndexRef.current = 0;
        chunkerRef.current.reset();
        turnRef.current = {
          endedAt: event.endedAt,
          endpoint: event.endpoint,
          speechMs: event.speechMs,
          sttMs: event.sttMs,
          transcriptAt: Date.now(),
          chunks: 0,
          transcript: event.text,
          calledTools: [],
          availableTools: [],
          succeededWrites: [],
          answer: "",
        };
        setState("thinking");
        onUserTurnRef.current(event.text);
      } else if (event.type === "tts-audio") {
        if (event.utteranceId !== utteranceRef.current) return;
        const turn = turnRef.current;
        if (turn && turn.firstAudioAt === undefined) {
          turn.firstAudioAt = Date.now();
          if (harnessRef.current) api?.reportTurnEvent({ type: "first-audio", at: turn.firstAudioAt });
        }
        playerRef.current?.enqueue(event.samples);
      } else if (event.type === "error") {
        logger.warn("Voice conversation error", { stage: event.stage, message: event.message }, "voice-conversation");
        onErrorRef.current?.(event.message);
      }
    },
    [api, bargeIn]
  );

  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  useEffect(() => {
    if (!api) return undefined;
    return api.onEvent((event: VoiceConversationEvent) => handleEventRef.current(event));
  }, [api]);

  const stop = useCallback(async () => {
    if (!activeRef.current && !micRef.current) return;
    bargeIn();
    activeRef.current = false;
    if (sessionTimerRef.current) clearInterval(sessionTimerRef.current);
    sessionTimerRef.current = null;
    await micRef.current?.stop().catch(() => {});
    micRef.current = null;
    await playerRef.current?.close().catch(() => {});
    playerRef.current = null;
    await api?.stop().catch(() => {});
    setState("off");
    logger.info("Voice conversation stopped", {}, "voice-conversation");
  }, [api, bargeIn]);

  const start = useCallback(async (harness = false) => {
    if (activeRef.current || !api) return;
    activeRef.current = true;
    harnessRef.current = harness;
    setHarnessActive(harness);
    setState("starting");
    try {
      const settings = getSettings();
      const { config: voiceModel } = resolveChatStreamingInference(settings, {
        inferenceScope: "dictationAgent",
      });
      const parakeetModel = settings.parakeetModel || DEFAULT_PARAKEET_MODEL;
      const brain = resolveVoiceBrain(voiceModel, brainOverride);
      const readiness = await api.getReadiness({
        parakeetModel,
        language: settings.preferredLanguage,
        brain,
      });
      // `readiness.ready === false`, not `!readiness.ready`: negation narrowing doesn't
      // discriminate this union in TS, so `readiness.reason` stays unresolved otherwise.
      if (readiness.ready === false) {
        onErrorRef.current?.(t(READINESS_MESSAGE_KEYS[readiness.reason]));
        activeRef.current = false;
        setState("off");
        return;
      }
      const info = await api.start({
        parakeetModel,
        brainModel: brainOverride || voiceModel.model,
        harness,
      });
      playerRef.current = createPcmPlayer({
        // Pocket synthesizes at 24 kHz.
        sampleRate: info.sampleRate || 24000,
        onStart: () => setState("speaking"),
        onIdle: () => {
          finishUtteranceIfDrained();
          if (activeRef.current) setState("listening");
        },
      });
      // One diagnostic line ~2 s in: proves frames flow and the mic isn't silent.
      // The harness plays synthesized speech into the VAD instead of the mic.
      let frames = 0;
      let peak = 0;
      micRef.current = harness ? null : await startMicStream({
        deviceId: settings.selectedMicDeviceId || null,
        onFrame: (frame) => {
          frames += 1;
          if (frames <= 64) {
            for (const sample of frame) peak = Math.max(peak, Math.abs(sample));
            if (frames === 64) {
              logger.info("Voice conversation mic check", { frames, peak: peak.toFixed(4) }, "voice-conversation");
            }
          }
          api.sendMic(frame);
        },
      });
      setState("listening");
      logger.info("Voice conversation started", info, "voice-conversation");

      // Keep a local voice model loaded for the whole session: warm it now so the
      // first turn skips the cold start, then beat llama-server's 5-minute idle stop.
      const keepWarm = () => {
        const localModel = brain.mode === "local" ? brain.model : null;
        if (localModel) {
          void api.keepModelWarm(localModel).catch(() => {});
        }
      };
      keepWarm();
      lastActivityRef.current = Date.now();
      let ticks = 0;
      sessionTimerRef.current = setInterval(() => {
        ticks += 1;
        if (ticks % KEEP_WARM_TICKS === 0) keepWarm();
        const busy = utteranceRef.current !== null || !!playerRef.current?.isPlaying();
        if (
          shouldStopForIdle({
            lastActivityAt: lastActivityRef.current,
            now: Date.now(),
            busy,
            idleMs: IDLE_STOP_MS,
          })
        ) {
          logger.info("Voice conversation idle stop", { idleMs: IDLE_STOP_MS }, "voice-conversation");
          void stopRef.current();
        }
      }, SESSION_TICK_MS);
    } catch (error) {
      const failure = error as DOMException & { constraint?: string };
      const message =
        failure?.message || [failure?.name, failure?.constraint].filter(Boolean).join(": ") || String(error);
      logger.error(
        "Voice conversation failed to start",
        { error: message, name: failure?.name, constraint: failure?.constraint },
        "voice-conversation"
      );
      onErrorRef.current?.(message);
      await stop();
    }
  }, [api, brainOverride, finishUtteranceIfDrained, stop, t]);

  const stopRef = useRef(stop);
  stopRef.current = stop;

  const toggle = useCallback(() => {
    void (activeRef.current ? stop() : start());
  }, [start, stop]);

  useEffect(
    () => () => {
      void stop();
    },
    [stop]
  );

  const speechTap = useMemo<AssistantSpeechTap>(
    () => ({
      onContentDelta: (delta) => {
        if (!utteranceRef.current) return;
        const turn = turnRef.current;
        if (turn) {
          turn.firstDeltaAt ??= Date.now();
          turn.answer += delta;
        }
        for (const chunk of chunkerRef.current.push(delta)) speakChunk(chunk);
      },
      onResponseDone: () => {
        if (!utteranceRef.current) return;
        responseDoneRef.current = true;
        for (const chunk of chunkerRef.current.flush()) speakChunk(chunk);
        finishUtteranceIfDrained();
      },
      onToolCall: (toolNames) => {
        if (!utteranceRef.current) return;
        turnRef.current?.calledTools.push(...toolNames);
        // Speak whatever the model said before calling the tool ("Let me check…");
        // if it said nothing yet, cover the wait with a short filler line.
        const pending = chunkerRef.current.flush();
        if (pending.length > 0) {
          for (const chunk of pending) speakChunk(chunk);
        } else if (chunkIndexRef.current === 0) {
          speakChunk(voiceToolFiller(toolNames));
        }
      },
      onToolsAvailable: (toolNames) => {
        if (turnRef.current) turnRef.current.availableTools = toolNames;
      },
      onWriteToolResult: (name, ok) => {
        if (ok) turnRef.current?.succeededWrites.push(name);
      },
      dryRunWrites: harnessActive,
      brainOverride,
      cancelRef,
    }),
    [brainOverride, finishUtteranceIfDrained, harnessActive, speakChunk]
  );

  useEffect(() => {
    if (!api) return undefined;
    return api.onHarnessDone(() => {
      logger.info("Voice conversation harness finished", {}, "voice-conversation");
      void stopRef.current();
    });
  }, [api]);

  const startHarness = useCallback(() => start(true), [start]);

  const active = state !== "off";
  return {
    enabled,
    harnessAvailable,
    active,
    state,
    toggle,
    stop,
    startHarness,
    speechTap: active ? speechTap : null,
  };
}
