import { useChatSendGateCore, type ChatSendGate } from './useChatSendGateCore';

export type { ChatSendGate, ChatSendGateOptions } from './useChatSendGateCore';
export function useChatSendGate(): ChatSendGate {
  return useChatSendGateCore();
}
