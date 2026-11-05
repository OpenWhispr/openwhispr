import {
  androidChatSendGateLifecycle,
  type AndroidChatSendGateOptions,
} from '@/android/chatSendGateLifecycle';
import { useChatSendGateCore, type ChatSendGate as BaseChatSendGate } from './useChatSendGateCore';

export type ChatSendGateOptions = AndroidChatSendGateOptions;
export type ChatSendGate = BaseChatSendGate<ChatSendGateOptions>;
export function useChatSendGate(): ChatSendGate {
  return useChatSendGateCore(androidChatSendGateLifecycle);
}
