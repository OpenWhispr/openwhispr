import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSettings, useSettingsStore } from "../../stores/settingsStore";
import { resolveChatStreamingInference } from "../../helpers/dictationAgentInference.js";
import logger from "../../utils/logger";
import { createSpeechChunker } from "../../services/voice/speechChunker";
import { createPcmPlayer, type PcmPlayer } from "../../services/voice/pcmPlayer";
import { startMicStream, type MicStream } from "../../services/voice/micStream";
import {
  detectSpokenLanguage,
  interruptionKind,
  isSpokenLanguage,
  moreInChatLine,
  onScreenLine,
  preparedLines,
  toolFiller,
  type SpokenLanguage,
} from "../../services/voice/voiceLines";
import type {
  VoiceConversationEvent,
  VoiceConversationReadiness,
  VoiceSpeechProfile,
  VoiceTurnEndpoint,
} from "../../services/voice/types";
import type { TurnSpeechObserver } from "../chat/chatTurnEngine";

/** off → starting → active, and back to off when the call ends or fails to start. */
export type VoiceCallSession = "off" | "starting" | "active";

/** Why a call didn't start: a readiness refusal, or the microphone. */
export type VoiceCallStartFailure =
  | Extract<VoiceConversationReadiness, { ready: false }>
  | { ready: false; reason: "mic-busy" | "mic-denied" | "start-failed" };

/** Why a running call ended without the user ending it. */
export type VoiceCallEndReason = "meeting" | "worker" | "idle" | "mic-lost";

/** A spoken turn: its text, and the observer that speaks its reply. */
export interface VoiceCallTurn {
  text: string;
  speech: TurnSpeechObserver;
  /** The language to answer in; null answers in the one spoken. */
  replyLanguage: SpokenLanguage | null;
}

interface UseVoiceCallOptions {
  /**
   * What the user said answers the question card a turn waits on: true when it
   * did, and that turn's reply goes on being spoken as it resumes.
   */
  answersCard: (text: string) => boolean;
  /** A finished spoken turn that starts a request. */
  onUserTurn: (turn: VoiceCallTurn) => void;
  /** The reply being spoken was dropped (barge-in or Stop): its turn should stop too. */
  onReplyDropped: () => void;
  /** The call ended on its own; the caller says why. */
  onEnded: (reason: VoiceCallEndReason) => void;
  /** A spoken turn couldn't be transcribed. */
  onTranscriptionFailed: () => void;
  /** Something besides speech keeps the call from idling out (a reply running, a card waiting). */
  isBusy: () => boolean;
}

interface TurnMetrics {
  endedAt: number;
  endpoint: VoiceTurnEndpoint | null;
  speechMs: number;
  sttMs: number;
  transcriptAt: number;
  firstTextAt?: number;
  firstChunkSentAt?: number;
  firstAudioAt?: number;
  /** First chunk only: waiting in the worker's TTS queue, then generating to first audio. */
  ttsQueueWaitMs?: number | null;
  ttsGenerateMs?: number | null;
  chunks: number;
  calledTools: string[];
  transcript: string;
  answer: string;
}

// A reply read aloud stops after this many sentences, with a line saying the rest
// is in the chat; the transcript keeps the whole answer. Bounded in code: brevity
// pressure in the prompt alone made the model skip tools (#2349's harness).
const MAX_SPOKEN_CHUNKS = 4;
// A call ends after 2.5 minutes with no speech either way and nothing in progress.
const IDLE_STOP_MS = 150_000;
const SESSION_TICK_MS = 10_000;
// Re-warm a local model every minute, well inside llama-server's 5-minute idle stop.
const KEEP_WARM_TICKS = 6;

const since = (from: number, to: number | undefined) =>
  to === undefined ? null : Math.round(to - from);

/**
 * The model that hears a call in this language: a local Parakeet-family one
 * unless the call's language needs Whisper. Main picks among the downloaded
 * ones, preferring the one dictation runs so its server isn't swapped.
 */
function recognizerPreferences(settings: ReturnType<typeof getSettings>) {
  return {
    preferredParakeet:
      settings.localTranscriptionProvider === "cohere"
        ? settings.cohereModel
        : settings.parakeetModel || undefined,
    preferredWhisper: settings.whisperModel || undefined,
  };
}

function uiSpokenLanguage(uiLanguage: string): SpokenLanguage {
  const base = uiLanguage.split("-")[0];
  return isSpokenLanguage(base) ? base : "en";
}

/**
 * A hands-free voice call on the agent window: an always-listening loop that turns
 * each spoken turn into a request and speaks the streamed answer back, with
 * barge-in. The call owns the microphone through the agent window's voice state,
 * so dictation stays off it while the call runs.
 */
export function useVoiceCall({
  answersCard,
  onUserTurn,
  onReplyDropped,
  onEnded,
  onTranscriptionFailed,
  isBusy,
}: UseVoiceCallOptions) {
  const [session, setSession] = useState<VoiceCallSession>("off");
  const [micMuted, setMicMutedState] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [failure, setFailure] = useState<VoiceCallStartFailure | null>(null);
  const [harnessAvailable, setHarnessAvailable] = useState(false);
  const activeRef = useRef(false);
  const sessionIdRef = useRef<number | null>(null);
  const attemptRef = useRef<string | null>(null);
  const micRef = useRef<MicStream | null>(null);
  const micMutedRef = useRef(false);
  const inputHeldRef = useRef(false);
  const playerRef = useRef<PcmPlayer | null>(null);
  const [chunker] = useState(() => createSpeechChunker());
  const utteranceRef = useRef<string | null>(null);
  const profileRef = useRef<VoiceSpeechProfile | null>(null);
  const responseDoneRef = useRef(false);
  const chunkIndexRef = useRef(0);
  // The reply ran past what a reply may say aloud.
  const cutShortRef = useRef(false);
  const pendingSpeaksRef = useRef(0);
  // Text the claim check flagged: spoken only once the turn shows it stands.
  const heldChunksRef = useRef<string[] | null>(null);
  const answerRef = useRef("");
  const claimCheckRef = useRef<((text: string) => boolean) | undefined>(undefined);
  // Playback is paused while the user may be talking over the answer (see speech-start).
  const heldForSpeechRef = useRef(false);
  const heardLanguageRef = useRef<SpokenLanguage | null>(null);
  const harnessRef = useRef(false);
  const lastActivityRef = useRef(0);
  const sessionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const turnRef = useRef<TurnMetrics | null>(null);
  const startGenerationRef = useRef(0);
  const callbacks = {
    answersCard,
    onUserTurn,
    onReplyDropped,
    onEnded,
    onTranscriptionFailed,
    isBusy,
  };
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const api = window.electronAPI?.voiceConversation;

  useEffect(() => {
    void api
      ?.isHarness()
      .then((value) => setHarnessAvailable(Boolean(value)))
      .catch(() => {});
  }, [api]);

  // The language this call speaks: its setting, or for Auto the one the reply is
  // written in, then the one last heard, then the UI's.
  const spokenLanguageFor = useCallback((text: string): SpokenLanguage => {
    const { voiceCallLanguage, uiLanguage } = getSettings();
    if (voiceCallLanguage !== "auto") return voiceCallLanguage;
    return detectSpokenLanguage(text) ?? heardLanguageRef.current ?? uiSpokenLanguage(uiLanguage);
  }, []);

  const speechProfile = useCallback((language: SpokenLanguage): VoiceSpeechProfile => {
    const { voiceCallVoice, voiceCallSpeed } = getSettings();
    return { voice: voiceCallVoice, speed: voiceCallSpeed, language };
  }, []);

  // Lines said while a tool runs play at once when they were synthesized ahead.
  const prepareLines = useCallback(
    (language: SpokenLanguage) => {
      void api
        ?.prepareSpeech({ texts: preparedLines(language), profile: speechProfile(language) })
        .catch(() => {});
    },
    [api, speechProfile]
  );

  const logTurn = useCallback(
    (outcome: string) => {
      const turn = turnRef.current;
      if (!turn) return;
      turnRef.current = null;
      const metrics = {
        speechMs: turn.speechMs,
        sttMs: turn.sttMs,
        transcriptToFirstTextMs: since(turn.transcriptAt, turn.firstTextAt),
        firstTextToFirstChunkMs: turn.firstTextAt
          ? since(turn.firstTextAt, turn.firstChunkSentAt)
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
        ttsQueueWaitMs: turn.ttsQueueWaitMs ?? null,
        ttsGenerateMs: turn.ttsGenerateMs ?? null,
        chunks: turn.chunks,
      };
      logger.info(
        "Voice call turn",
        { outcome, endpointReason: turn.endpoint?.reason ?? null, ...metrics },
        "voice-call"
      );
      if (harnessRef.current) {
        api?.reportTurn({
          outcome,
          transcript: turn.transcript,
          calledTools: turn.calledTools,
          availableTools: [],
          ranWrites: [],
          answer: turn.answer,
          endedAt: turn.endedAt,
          metrics,
        });
      }
    },
    [api]
  );

  // A turn ends only when the answer is complete, every chunk is synthesized and
  // playback has drained; a gap between two chunks' audio must not end it early.
  const finishUtteranceIfDrained = useCallback(() => {
    if (!utteranceRef.current || !responseDoneRef.current) return;
    if (pendingSpeaksRef.current > 0 || playerRef.current?.isPlaying()) return;
    utteranceRef.current = null;
    if (heldForSpeechRef.current) {
      heldForSpeechRef.current = false;
      playerRef.current?.resume();
    }
    logTurn(chunkIndexRef.current === 0 ? "empty" : "spoke");
  }, [logTurn]);

  const speakChunk = useCallback(
    (text: string) => {
      const utteranceId = utteranceRef.current;
      if (!utteranceId || !api) return;
      // The first chunk fixes the voice, rate and language for the whole answer.
      profileRef.current ??= speechProfile(spokenLanguageFor(text));
      const turn = turnRef.current;
      if (turn) {
        turn.firstChunkSentAt ??= Date.now();
        turn.chunks += 1;
      }
      const chunkIndex = chunkIndexRef.current++;
      pendingSpeaksRef.current += 1;
      void api
        .speak({ utteranceId, chunkIndex, text, profile: profileRef.current })
        .then((result) => {
          if (chunkIndex === 0 && turn && turnRef.current === turn) {
            turn.ttsQueueWaitMs = result?.queueWaitMs ?? null;
            turn.ttsGenerateMs = result?.firstAudioMs ?? null;
          }
        })
        .catch((error: Error) => {
          logger.warn("Voice call TTS failed", { error: error.message }, "voice-call");
        })
        .finally(() => {
          pendingSpeaksRef.current -= 1;
          if (utteranceRef.current === utteranceId) finishUtteranceIfDrained();
        });
    },
    [api, finishUtteranceIfDrained, speechProfile, spokenLanguageFor]
  );

  // Speaks a chunk, unless the reply already said all a reply may (the rest is in
  // the chat) or the claim check flags it.
  const offerChunk = useCallback(
    (chunk: string) => {
      const held = heldChunksRef.current;
      if (held) {
        held.push(chunk);
        return;
      }
      if (claimCheckRef.current?.(answerRef.current)) {
        heldChunksRef.current = [chunk];
        return;
      }
      if (chunkIndexRef.current < MAX_SPOKEN_CHUNKS) speakChunk(chunk);
      else cutShortRef.current = true;
    },
    [speakChunk]
  );

  /** Drops the answer in progress: the user interrupted it, stopped it, or ended the call. */
  const dropAnswer = useCallback(
    (outcome: "barge-in" | "stopped") => {
      const utteranceId = utteranceRef.current;
      utteranceRef.current = null;
      heldForSpeechRef.current = false;
      heldChunksRef.current = null;
      chunker.reset();
      playerRef.current?.flush();
      if (!utteranceId) return;
      void api?.cancelSpeech(utteranceId);
      if (!responseDoneRef.current) callbacksRef.current.onReplyDropped();
      logTurn(outcome);
    },
    [api, chunker, logTurn]
  );

  const createTurnSpeech = useCallback(
    (utteranceId: string): TurnSpeechObserver => {
      const current = () => utteranceRef.current === utteranceId;
      return {
        onText: (delta, isUnbacked) => {
          if (!current()) return;
          claimCheckRef.current = isUnbacked;
          answerRef.current += delta;
          const turn = turnRef.current;
          if (turn) {
            turn.firstTextAt ??= Date.now();
            turn.answer = answerRef.current;
          }
          for (const chunk of chunker.push(delta)) offerChunk(chunk);
        },
        onTextWithdrawn: () => {
          if (!current()) return;
          heldChunksRef.current = null;
          chunker.reset();
        },
        onToolCalls: (toolNames) => {
          if (!current()) return;
          turnRef.current?.calledTools.push(...toolNames);
          // Speak what the model said before calling the tool ("Let me check…"); if
          // it said nothing yet, cover the wait with a short line.
          const pending = chunker.flush();
          for (const chunk of pending) offerChunk(chunk);
          if (pending.length === 0 && chunkIndexRef.current === 0 && !heldChunksRef.current) {
            speakChunk(toolFiller(toolNames, spokenLanguageFor(answerRef.current)));
          }
        },
        onEnd: (outcome) => {
          if (!current() || responseDoneRef.current) return;
          for (const chunk of chunker.flush()) offerChunk(chunk);
          const held = heldChunksRef.current;
          heldChunksRef.current = null;
          // Held text is spoken once the finished turn backs it, and never otherwise.
          if (held && !claimCheckRef.current?.(answerRef.current)) {
            for (const chunk of held) offerChunk(chunk);
          }
          if (cutShortRef.current && profileRef.current) {
            speakChunk(moreInChatLine(profileRef.current.language));
          }
          responseDoneRef.current = true;
          if (outcome === "stopped") logTurn("stopped");
          finishUtteranceIfDrained();
        },
      };
    },
    [chunker, finishUtteranceIfDrained, logTurn, offerChunk, speakChunk, spokenLanguageFor]
  );

  // A cough or a sound the VAD mistook for speech transcribes to nothing, so talking
  // over the answer only pauses it; the words decide whether to drop it.
  const releaseHold = useCallback(() => {
    if (!heldForSpeechRef.current) return;
    heldForSpeechRef.current = false;
    playerRef.current?.resume();
    setSpeaking(Boolean(playerRef.current?.isPlaying()));
  }, []);

  const releaseMic = useCallback(async () => {
    const mic = micRef.current;
    micRef.current = null;
    await mic?.stop().catch(() => {});
  }, []);

  const releaseVoiceState = useCallback(() => {
    const attempt = attemptRef.current;
    attemptRef.current = null;
    if (attempt)
      void window.electronAPI?.agentWindowSetVoiceState?.("idle", attempt).catch(() => {});
  }, []);

  const end = useCallback(async () => {
    // A start() still awaiting sees the new generation and backs out.
    startGenerationRef.current += 1;
    if (!activeRef.current) return;
    activeRef.current = false;
    dropAnswer("stopped");
    if (sessionTimerRef.current) clearInterval(sessionTimerRef.current);
    sessionTimerRef.current = null;
    await releaseMic();
    await playerRef.current?.close().catch(() => {});
    playerRef.current = null;
    await api?.stop(sessionIdRef.current).catch(() => {});
    sessionIdRef.current = null;
    releaseVoiceState();
    harnessRef.current = false;
    micMutedRef.current = false;
    inputHeldRef.current = false;
    setMicMutedState(false);
    setSpeaking(false);
    setSession("off");
    logger.info("Voice call ended", {}, "voice-call");
  }, [api, dropAnswer, releaseMic, releaseVoiceState]);
  const endRef = useRef(end);
  endRef.current = end;

  const endOnItsOwn = useCallback((reason: VoiceCallEndReason) => {
    void endRef.current();
    callbacksRef.current.onEnded(reason);
  }, []);

  const openMic = useCallback(async () => {
    let frames = 0;
    let peak = 0;
    const mic = await startMicStream({
      deviceId: getSettings().selectedMicDeviceId || null,
      onFrame: (frame) => {
        // One diagnostic line ~2 s in: frames flow and the mic isn't silent.
        if (frames < 64) {
          frames += 1;
          for (const sample of frame) peak = Math.max(peak, Math.abs(sample));
          if (frames === 64) {
            logger.info("Voice call mic check", { peak: peak.toFixed(4) }, "voice-call");
          }
        }
        if (!inputHeldRef.current) api?.sendMic(frame);
      },
      onEnded: () => {
        if (activeRef.current && micRef.current === mic) endOnItsOwn("mic-lost");
      },
    });
    return mic;
  }, [api, endOnItsOwn]);

  const pauseInput = useCallback(
    (paused: boolean) => {
      const sessionId = sessionIdRef.current;
      if (sessionId !== null) void api?.pauseInput(sessionId, paused).catch(() => {});
    },
    [api]
  );

  /** Microphone off: nothing reaches the call, and the device is released. */
  const setMicMuted = useCallback(
    async (muted: boolean) => {
      if (!activeRef.current || micMutedRef.current === muted) return;
      micMutedRef.current = muted;
      setMicMutedState(muted);
      pauseInput(muted || inputHeldRef.current);
      if (muted) {
        await releaseMic();
        return;
      }
      if (harnessRef.current) return;
      try {
        const mic = await openMic();
        // Muted again, or the call ended, while the device opened.
        if (!activeRef.current || micMutedRef.current) await mic.stop().catch(() => {});
        else micRef.current = mic;
      } catch (error) {
        logger.warn(
          "Voice call mic reopen failed",
          { error: (error as Error).message },
          "voice-call"
        );
        endOnItsOwn("mic-lost");
      }
    },
    [endOnItsOwn, openMic, pauseInput, releaseMic]
  );

  /** A card asks for a secret: what the user says meanwhile is never transcribed. */
  const setInputHeld = useCallback(
    (held: boolean) => {
      if (inputHeldRef.current === held) return;
      inputHeldRef.current = held;
      if (activeRef.current) pauseInput(held || micMutedRef.current);
    },
    [pauseInput]
  );

  /** Stops only the reply being spoken; the call keeps listening. */
  const stopReply = useCallback(() => dropAnswer("stopped"), [dropAnswer]);

  /**
   * Says what the card the reply waits on asks (a question's prompt), or
   * without text that it is on screen. Part of the reply being spoken, so
   * talking over it works as over the rest.
   */
  const announce = useCallback(
    (text?: string) => {
      if (!utteranceRef.current) return;
      if (!text) {
        speakChunk(onScreenLine(spokenLanguageFor(answerRef.current)));
        return;
      }
      const lines = createSpeechChunker();
      for (const chunk of [...lines.push(text), ...lines.flush()]) speakChunk(chunk);
    },
    [speakChunk, spokenLanguageFor]
  );

  const handleEvent = useCallback(
    (event: VoiceConversationEvent) => {
      if (!activeRef.current) return;
      if (event.type !== "error") lastActivityRef.current = Date.now();
      if (event.type === "speech-start") {
        if (utteranceRef.current && !heldForSpeechRef.current) {
          heldForSpeechRef.current = true;
          playerRef.current?.pause();
          setSpeaking(false);
          if (harnessRef.current) api?.reportTurnEvent({ type: "flushed", at: Date.now() });
        }
      } else if (event.type === "transcript") {
        if (!event.text) {
          releaseHold();
          return;
        }
        if (callbacksRef.current.answersCard(event.text)) {
          // The question needn't be heard out; its turn goes on speaking as it resumes.
          heldForSpeechRef.current = false;
          playerRef.current?.flush();
          if (utteranceRef.current) void api?.cancelSpeech(utteranceRef.current);
          return;
        }
        if (utteranceRef.current) {
          // Over a reply, one word is a backchannel ("okay", "please") or a stop;
          // only more than that is a new request.
          const kind = interruptionKind(event.text);
          if (kind === "ignore") {
            releaseHold();
            return;
          }
          if (kind === "stop") {
            dropAnswer("stopped");
            return;
          }
          dropAnswer("barge-in");
        }
        const utteranceId = crypto.randomUUID();
        utteranceRef.current = utteranceId;
        profileRef.current = null;
        responseDoneRef.current = false;
        chunkIndexRef.current = 0;
        cutShortRef.current = false;
        answerRef.current = "";
        heldChunksRef.current = null;
        claimCheckRef.current = undefined;
        chunker.reset();
        heardLanguageRef.current = detectSpokenLanguage(event.text) ?? heardLanguageRef.current;
        turnRef.current = {
          endedAt: event.endedAt,
          endpoint: event.endpoint,
          speechMs: event.speechMs,
          sttMs: event.sttMs,
          transcriptAt: Date.now(),
          chunks: 0,
          calledTools: [],
          transcript: event.text,
          answer: "",
        };
        const { voiceCallLanguage } = getSettings();
        callbacksRef.current.onUserTurn({
          text: event.text,
          speech: createTurnSpeech(utteranceId),
          replyLanguage: voiceCallLanguage === "auto" ? null : voiceCallLanguage,
        });
      } else if (event.type === "tts-audio") {
        if (event.utteranceId !== utteranceRef.current) return;
        const turn = turnRef.current;
        if (turn && turn.firstAudioAt === undefined) {
          turn.firstAudioAt = Date.now();
          if (harnessRef.current) {
            api?.reportTurnEvent({ type: "first-audio", at: turn.firstAudioAt });
          }
        }
        playerRef.current?.enqueue(event.samples);
      } else if (event.type === "error") {
        logger.warn(
          "Voice call error",
          { stage: event.stage, message: event.message },
          "voice-call"
        );
        if (event.stage === "worker") {
          endOnItsOwn("worker");
        } else {
          // That speech never becomes a turn, so an answer it paused carries on.
          releaseHold();
          callbacksRef.current.onTranscriptionFailed();
        }
      } else if (event.type === "ended") {
        endOnItsOwn("meeting");
      }
    },
    [api, chunker, createTurnSpeech, dropAnswer, endOnItsOwn, releaseHold]
  );
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  useEffect(() => {
    if (!api) return undefined;
    return api.onEvent((event) => handleEventRef.current(event));
  }, [api]);

  /** Resolves true once the call listens; false when it was refused or cancelled. */
  const start = useCallback(
    async ({ harness = false }: { harness?: boolean } = {}): Promise<boolean> => {
      if (activeRef.current || !api) return false;
      activeRef.current = true;
      // end() can land during any await below; it has already reset state, so a
      // stale start only undoes what it opened itself.
      const generation = ++startGenerationRef.current;
      const isStale = () => startGenerationRef.current !== generation;
      let sessionId: number | null = null;
      let mic: MicStream | null = null;
      const attempt = `call-${crypto.randomUUID()}`;
      const abandon = async () => {
        await mic?.stop().catch(() => {});
        // Ends only the session this start opened, never a newer one.
        if (sessionId !== null) await api.stop(sessionId).catch(() => {});
        if (attemptRef.current === attempt) releaseVoiceState();
        return false;
      };
      const refuse = (refusal: VoiceCallStartFailure) => {
        logger.warn("Voice call not started", { reason: refusal.reason, harness }, "voice-call");
        setFailure(refusal);
        activeRef.current = false;
        setSession("off");
        return false;
      };
      harnessRef.current = harness;
      setFailure(null);
      setSession("starting");
      try {
        // The call holds the mic like a take does, so dictation can't start under it.
        const admitted = await window.electronAPI?.agentWindowSetVoiceState?.("recording", attempt);
        if (admitted === true) attemptRef.current = attempt;
        if (isStale()) return abandon();
        if (admitted !== true) return refuse({ ready: false, reason: "mic-busy" });

        const settings = getSettings();
        const language = harness ? "en" : settings.voiceCallLanguage;
        const { config: brainConfig } = resolveChatStreamingInference(settings, {
          inferenceScope: "dictationAgent",
        });
        const recognizer = recognizerPreferences(settings);
        const readiness = await api.getReadiness({
          language,
          ...recognizer,
          brain: {
            mode: brainConfig.mode || "",
            model: brainConfig.model || "",
            provider: brainConfig.provider || "",
            signedIn: settings.isSignedIn,
          },
        });
        if (isStale()) return abandon();
        if (readiness.ready === false) {
          releaseVoiceState();
          return refuse(readiness);
        }
        const info = await api.start({ language, ...recognizer, harness });
        sessionId = info.sessionId;
        if (isStale()) return abandon();
        sessionIdRef.current = sessionId;
        // end() closes this player if it lands while the mic is opening.
        playerRef.current = createPcmPlayer({
          // Supertonic synthesizes at 44.1 kHz.
          sampleRate: info.sampleRate || 44100,
          onStart: () => {
            if (!heldForSpeechRef.current) setSpeaking(true);
          },
          onIdle: () => {
            setSpeaking(false);
            finishUtteranceIfDrained();
          },
        });
        // The harness plays synthesized speech into the VAD instead of the mic.
        mic = harness ? null : await openMic();
        if (isStale()) return abandon();
        micRef.current = mic;
        setSession("active");
        logger.info("Voice call started", { ...info, language }, "voice-call");
        heardLanguageRef.current = null;
        prepareLines(language === "auto" ? uiSpokenLanguage(settings.uiLanguage) : language);

        // Keep a local voice model loaded for the whole call: warm it now so the first
        // turn skips the cold start, then beat llama-server's 5-minute idle stop.
        const keepWarm = () => {
          if (brainConfig.mode === "local" && brainConfig.model) {
            void api.keepModelWarm(brainConfig.model).catch(() => {});
          }
        };
        keepWarm();
        lastActivityRef.current = Date.now();
        let ticks = 0;
        sessionTimerRef.current = setInterval(() => {
          ticks += 1;
          if (ticks % KEEP_WARM_TICKS === 0) keepWarm();
          const busy =
            utteranceRef.current !== null ||
            Boolean(playerRef.current?.isPlaying()) ||
            callbacksRef.current.isBusy();
          if (busy) lastActivityRef.current = Date.now();
          else if (Date.now() - lastActivityRef.current >= IDLE_STOP_MS) {
            logger.info("Voice call idle stop", { idleMs: IDLE_STOP_MS }, "voice-call");
            endOnItsOwn("idle");
          }
        }, SESSION_TICK_MS);
        return true;
      } catch (error) {
        // Cancelled mid-start: not an error for the user, and end() here could end a newer call.
        if (isStale()) return abandon();
        const failed = error as DOMException;
        logger.error(
          "Voice call failed to start",
          { error: failed?.message || String(error), name: failed?.name },
          "voice-call"
        );
        await mic?.stop().catch(() => {});
        if (sessionId !== null) await api.stop(sessionId).catch(() => {});
        sessionIdRef.current = null;
        await playerRef.current?.close().catch(() => {});
        playerRef.current = null;
        releaseVoiceState();
        return refuse({
          ready: false,
          reason: failed?.name === "NotAllowedError" ? "mic-denied" : "start-failed",
        });
      }
    },
    [api, endOnItsOwn, finishUtteranceIfDrained, openMic, prepareLines, releaseVoiceState]
  );

  // A different voice, rate or language makes every prepared line stale; the
  // answer playing now keeps its own (it fixed its profile at its first chunk).
  useEffect(
    () =>
      useSettingsStore.subscribe((settings, previous) => {
        if (!activeRef.current) return;
        if (settings.voiceCallLanguage !== previous.voiceCallLanguage) {
          // The next turn is heard by a model that knows the new language.
          const sessionId = sessionIdRef.current;
          heardLanguageRef.current = null;
          if (sessionId !== null) {
            void api
              ?.setLanguage(sessionId, {
                language: settings.voiceCallLanguage,
                ...recognizerPreferences(getSettings()),
              })
              .catch(() => {});
          }
        } else if (
          settings.voiceCallVoice === previous.voiceCallVoice &&
          settings.voiceCallSpeed === previous.voiceCallSpeed
        ) {
          return;
        }
        prepareLines(spokenLanguageFor(""));
      }),
    [api, prepareLines, spokenLanguageFor]
  );

  useEffect(
    () => () => {
      void endRef.current();
    },
    []
  );

  /** The waveform: the reply while it plays, the microphone otherwise. */
  const readLevel = useCallback(
    () => Math.max(playerRef.current?.readLevel() ?? 0, micRef.current?.readLevel() ?? 0),
    []
  );

  return useMemo(
    () => ({
      session,
      micMuted,
      speaking,
      failure,
      harnessAvailable,
      readLevel,
      start,
      end,
      stopReply,
      announce,
      setMicMuted,
      setInputHeld,
      clearFailure: () => setFailure(null),
    }),
    [
      announce,
      end,
      failure,
      harnessAvailable,
      micMuted,
      readLevel,
      session,
      setInputHeld,
      setMicMuted,
      speaking,
      start,
      stopReply,
    ]
  );
}
