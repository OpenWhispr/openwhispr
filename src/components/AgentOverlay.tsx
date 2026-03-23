import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "./lib/utils";
import { AgentTitleBar } from "./agent/AgentTitleBar";
import { AgentChat } from "./agent/AgentChat";
import { AgentInput } from "./agent/AgentInput";
import AudioManager from "../helpers/audioManager";
import ReasoningService from "../services/ReasoningService";
import { getSettings } from "../stores/settingsStore";
import { getAgentSystemPrompt } from "../config/prompts";

type AgentState = "idle" | "listening" | "transcribing" | "thinking" | "streaming";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming: boolean;
}

const MIN_HEIGHT = 200;
const MIN_WIDTH = 360;

export default function AgentOverlay() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [partialTranscript, setPartialTranscript] = useState("");
  const audioManagerRef = useRef<InstanceType<typeof AudioManager> | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const agentStateRef = useRef<AgentState>("idle");
  const conversationIdRef = useRef<number | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    agentStateRef.current = agentState;
  }, [agentState]);

  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "assistant" as const, content, isStreaming: false },
    ]);
  }, []);

  const handleTranscriptionComplete = useCallback(async (text: string) => {
    if (!text.trim()) {
      setAgentState("idle");
      return;
    }

    // Create conversation on first message
    if (!conversationIdRef.current) {
      const conv = await window.electronAPI?.createAgentConversation?.("New conversation");
      conversationIdRef.current = conv?.id ?? null;
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      isStreaming: false,
    };
    setMessages((prev) => [...prev, userMsg]);

    if (conversationIdRef.current) {
      window.electronAPI?.addAgentMessage?.(conversationIdRef.current, "user", text);
    }

    // Auto-title after first user message
    const allMessages = messagesRef.current;
    if (conversationIdRef.current && allMessages.length === 0) {
      const title = text.slice(0, 50) + (text.length > 50 ? "..." : "");
      window.electronAPI?.updateAgentConversationTitle?.(conversationIdRef.current, title);
    }

    setAgentState("thinking");

    const settings = getSettings();
    const systemPrompt = getAgentSystemPrompt();

    const llmMessages = [
      { role: "system", content: systemPrompt },
      ...[...allMessages, userMsg].slice(-20).map((m) => ({ role: m.role, content: m.content })),
    ];

    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", isStreaming: true },
    ]);
    setAgentState("streaming");

    const isCloudAgent = settings.isSignedIn && settings.cloudAgentMode === "openwhispr";

    try {
      let fullContent = "";

      const streamSource = isCloudAgent
        ? ReasoningService.processTextStreamingCloud(llmMessages, { systemPrompt })
        : ReasoningService.processTextStreaming(
            llmMessages,
            settings.agentModel,
            settings.agentProvider,
            {
              systemPrompt,
              reasoningEffort: settings.agentReasoningEffort,
            }
          );

      for await (const chunk of streamSource) {
        fullContent += chunk;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m))
        );
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m))
      );

      if (conversationIdRef.current) {
        window.electronAPI?.addAgentMessage?.(conversationIdRef.current, "assistant", fullContent);
      }
    } catch (error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Error: ${(error as Error).message}`, isStreaming: false }
            : m
        )
      );
    }

    setAgentState("idle");
  }, []);

  useEffect(() => {
    const am = new AudioManager();
    am.setSkipReasoning(true);
    am.setContext("agent");
    am.setCallbacks({
      onStateChange: ({
        isRecording,
        isProcessing,
      }: {
        isRecording: boolean;
        isProcessing: boolean;
      }) => {
        if (isRecording) setAgentState("listening");
        else if (isProcessing) setAgentState("transcribing");
      },
      onError: (error: { message?: string }) => {
        const msg = error?.message || (typeof error === "string" ? error : "Transcription failed");
        addSystemMessage(`Error: ${msg}`);
        setAgentState("idle");
      },
      onTranscriptionComplete: (result: { text: string }) => {
        handleTranscriptionComplete(result.text);
      },
      onPartialTranscript: (text: string) => {
        setPartialTranscript(text);
      },
      onStreamingCommit: undefined,
    });
    audioManagerRef.current = am;
    return () => {
      window.removeEventListener("api-key-changed", (am as any)._onApiKeyChanged);
    };
  }, [addSystemMessage, handleTranscriptionComplete]);

  const handleResizeStart = useCallback((e: React.MouseEvent, direction: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.screenX;
    const startY = e.screenY;

    window.electronAPI?.getAgentWindowBounds?.().then((bounds) => {
      if (!bounds) return;
      const startBounds = { ...bounds };

      const handleMouseMove = (ev: MouseEvent) => {
        const dx = ev.screenX - startX;
        const dy = ev.screenY - startY;
        let { x, y, width, height } = startBounds;

        if (direction.includes("e")) width += dx;
        if (direction.includes("w")) {
          x += dx;
          width -= dx;
        }
        if (direction.includes("s")) height += dy;
        if (direction.includes("n")) {
          y += dy;
          height -= dy;
        }

        width = Math.max(MIN_WIDTH, width);
        height = Math.max(MIN_HEIGHT, height);

        window.electronAPI?.setAgentWindowBounds?.(x, y, width, height);
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.electronAPI?.hideAgentOverlay?.();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const unsubStart = window.electronAPI?.onAgentStartRecording?.(() => {
      audioManagerRef.current?.startRecording();
    });

    const unsubStop = window.electronAPI?.onAgentStopRecording?.(() => {
      audioManagerRef.current?.stopRecording();
    });

    const unsubToggle = window.electronAPI?.onAgentToggleRecording?.(() => {
      const state = agentStateRef.current;
      if (state === "listening") {
        audioManagerRef.current?.stopRecording();
      } else if (state === "idle") {
        audioManagerRef.current?.startRecording();
      }
    });

    return () => {
      unsubStart?.();
      unsubStop?.();
      unsubToggle?.();
    };
  }, []);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setAgentState("idle");
    setPartialTranscript("");
    conversationIdRef.current = null;
  }, []);

  const handleClose = useCallback(() => {
    window.electronAPI?.hideAgentOverlay?.();
  }, []);

  return (
    <div className="agent-overlay-window w-screen h-screen bg-transparent relative">
      <div
        className={cn(
          "flex flex-col w-full h-full",
          "bg-surface-0",
          "border border-border/50 rounded-lg",
          "shadow-[var(--shadow-elevated)]",
          "overflow-hidden"
        )}
      >
        <AgentTitleBar onNewChat={handleNewChat} onClose={handleClose} />
        <AgentChat messages={messages} />
        <AgentInput agentState={agentState} partialTranscript={partialTranscript} />
      </div>

      {/* Resize handles — edges */}
      <div
        className="absolute top-0 left-2 right-2 h-[5px] cursor-n-resize"
        onMouseDown={(e) => handleResizeStart(e, "n")}
      />
      <div
        className="absolute bottom-0 left-2 right-2 h-[5px] cursor-s-resize"
        onMouseDown={(e) => handleResizeStart(e, "s")}
      />
      <div
        className="absolute left-0 top-2 bottom-2 w-[5px] cursor-w-resize"
        onMouseDown={(e) => handleResizeStart(e, "w")}
      />
      <div
        className="absolute right-0 top-2 bottom-2 w-[5px] cursor-e-resize"
        onMouseDown={(e) => handleResizeStart(e, "e")}
      />

      {/* Resize handles — corners */}
      <div
        className="absolute top-0 left-0 w-[10px] h-[10px] cursor-nw-resize"
        onMouseDown={(e) => handleResizeStart(e, "nw")}
      />
      <div
        className="absolute top-0 right-0 w-[10px] h-[10px] cursor-ne-resize"
        onMouseDown={(e) => handleResizeStart(e, "ne")}
      />
      <div
        className="absolute bottom-0 left-0 w-[10px] h-[10px] cursor-sw-resize"
        onMouseDown={(e) => handleResizeStart(e, "sw")}
      />
      <div
        className="absolute bottom-0 right-0 w-[10px] h-[10px] cursor-se-resize"
        onMouseDown={(e) => handleResizeStart(e, "se")}
      />
    </div>
  );
}
