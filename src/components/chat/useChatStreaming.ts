import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "../../hooks/useAuth";
import {
  createChatTurnEngine,
  type ChatTurnEngine,
  type ChatTurnOptions,
  type SendToAIOptions,
} from "./chatTurnEngine";
import type { AgentState, Message } from "./types";

export type {
  ChatStreamingScope,
  OpenNoteContext,
  SendToAIOptions,
  TurnDetails,
  TurnHandler,
} from "./chatTurnEngine";

interface UseChatStreamingOptions extends Omit<ChatTurnOptions, "userName" | "isOwnerCurrent"> {
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

export interface ChatStreaming {
  agentState: AgentState;
  toolStatus: string;
  activeToolName: string;
  sendToAI: (userText: string, messages: Message[], options?: SendToAIOptions) => Promise<void>;
  cancelStream: () => void;
}

export function useChatStreaming(options: UseChatStreamingOptions): ChatStreaming {
  const { user } = useAuth();
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [toolStatus, setToolStatus] = useState("");
  const [activeToolName, setActiveToolName] = useState("");
  const optionsRef = useRef<ChatTurnOptions>({ ...options, userName: user?.name ?? null });
  optionsRef.current = { ...options, userName: user?.name ?? null };
  const messagesRef = useRef(options.setMessages);
  messagesRef.current = options.setMessages;
  const engineRef = useRef<ChatTurnEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = createChatTurnEngine(() => optionsRef.current, {
      setMessages: (update) => messagesRef.current(update),
      setAgentState,
      setToolStatus,
      setActiveToolName,
    });
  }
  const engine = engineRef.current;
  useEffect(() => () => engine.cancel({ explicit: false }), [engine]);
  const cancelStream = useCallback((): void => engine.cancel({ explicit: true }), [engine]);
  return { agentState, toolStatus, activeToolName, sendToAI: engine.send, cancelStream };
}
