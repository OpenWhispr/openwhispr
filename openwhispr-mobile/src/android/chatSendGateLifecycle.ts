import { confirmCloudOnce } from '@/lib/alerts';
import { isChatEnabled } from '@/lib/dictationAgent';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { ChatSendGateLifecycle, ChatSendGateOptions } from '@/hooks/useChatSendGateCore';

export type AndroidChatSendGateOptions = ChatSendGateOptions & {
  isCurrent?: () => boolean;
  consentLabels?: Parameters<typeof confirmCloudOnce>[2];
};

export const androidChatSendGateLifecycle: ChatSendGateLifecycle<AndroidChatSendGateOptions> = {
  capture: (enabled, { isCurrent: callerIsCurrent }) => {
    if (!enabled) return null;
    const context = {
      accountId: useAuthStore.getState().user?.id,
      cookie: useAuthStore.getState().sessionCookie,
      mode: useProcessingModeStore.getState().activeMode,
      routing: JSON.stringify(useConfigStore.getState().config?.inference),
    };
    // Consent and paywalls can outlive the account, route or originating note.
    return () => {
      if (callerIsCurrent && !callerIsCurrent()) return false;
      const auth = useAuthStore.getState();
      const config = useConfigStore.getState().config;
      return (
        auth.user?.id === context.accountId &&
        auth.sessionCookie === context.cookie &&
        useProcessingModeStore.getState().activeMode === context.mode &&
        JSON.stringify(config?.inference) === context.routing &&
        isChatEnabled(config)
      );
    };
  },
  confirm: (message, onConfirm, { consentLabels }) => {
    if (consentLabels) confirmCloudOnce(message, onConfirm, consentLabels);
    else confirmCloudOnce(message, onConfirm);
  },
};
