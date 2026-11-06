import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "../../hooks/useAuth";
import { getAuthRequestContextSnapshot, subscribeAuthBoundary } from "../../lib/authRequestContext";
import {
  createChatTurnEngine,
  type ChatTurnEngine,
  type ChatTurnOptions,
  type SendToAIOptions,
} from "./chatTurnEngine";
import type { AgentState, Message } from "./types";

export type { OpenNoteContext, SendToAIOptions, TurnDetails, TurnHandler } from "./chatTurnEngine";

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
  const optionsRef = useRef<Omit<ChatTurnOptions, "isOwnerCurrent">>({
    ...options,
    userName: user?.name ?? null,
  });
  optionsRef.current = { ...options, userName: user?.name ?? null };
  const messagesRef = useRef(options.setMessages);
  messagesRef.current = options.setMessages;
  const accountVersionRef = useRef(0);
  // One engine per account: a turn started before an account change writes nothing after it.
  const createEngine = useCallback((): ChatTurnEngine => {
    const accountVersion = accountVersionRef.current;
    const authGeneration = getAuthRequestContextSnapshot().observedGeneration;
    const isOwnerCurrent = (): boolean =>
      accountVersion === accountVersionRef.current &&
      authGeneration === getAuthRequestContextSnapshot().observedGeneration;
    return createChatTurnEngine(() => ({ ...optionsRef.current, isOwnerCurrent }), {
      setMessages: (update) => messagesRef.current(update),
      setAgentState,
      setToolStatus,
      setActiveToolName,
    });
  }, []);
  const engineRef = useRef<ChatTurnEngine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine();
  useEffect(
    () =>
      subscribeAuthBoundary(() => {
        engineRef.current?.cancel({ explicit: true });
        accountVersionRef.current += 1;
        engineRef.current = createEngine();
        setAgentState("idle");
        setToolStatus("");
        setActiveToolName("");
      }),
    [createEngine]
  );
  useEffect(() => () => engineRef.current?.cancel({ explicit: false }), []);
  const sendToAI = useCallback<ChatStreaming["sendToAI"]>(
    (userText, messages, sendOptions) => engineRef.current!.send(userText, messages, sendOptions),
    []
  );
  const cancelStream = useCallback((): void => engineRef.current?.cancel({ explicit: true }), []);
  return { agentState, toolStatus, activeToolName, sendToAI, cancelStream };
}
