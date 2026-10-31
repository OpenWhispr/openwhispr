import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { requiresRealAccount, showAccountRequiredAlert } from '@/lib/accountAccess';
import { confirmCloudOnce } from '@/lib/alerts';
import { isChatEnabled } from '@/lib/dictationAgent';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';

export type ChatSendGateOptions = {
  /** Shown before the request leaves the phone; null sends without asking. */
  consentMessage: string | null;
  source: 'note_chat' | 'chat_tab';
  isCurrent?: () => boolean;
  consentLabels?: Parameters<typeof confirmCloudOnce>[2];
};

export type ChatSendGate = {
  chatEnabled: boolean;
  gate: (run: (allowCloudFallback: boolean) => void, options: ChatSendGateOptions) => void;
};

/** The checks every chat send passes: account, Superwall paywall, then Local Mode consent. */
export function useChatSendGate(): ChatSendGate {
  const user = useAuthStore((s) => s.user);
  const { register: registerSuperwallGate } = useSuperwallGate();
  const chatMode = useConfigStore((s) => s.config?.inference?.noteChat?.mode);
  const chatEnabled = useConfigStore((s) => isChatEnabled(s.config));
  // Only an unset or OpenWhispr chat route reaches Cloud, so only it needs an account and the paywall.
  const cloudChat = chatMode !== 'providers' && chatMode !== 'local';

  const gate = useCallback<ChatSendGate['gate']>(
    (run, { consentMessage, source, isCurrent: callerIsCurrent, consentLabels }) => {
      if (!chatEnabled) return;
      const context =
        Platform.OS === 'android'
          ? {
              accountId: useAuthStore.getState().user?.id,
              cookie: useAuthStore.getState().sessionCookie,
              mode: useProcessingModeStore.getState().activeMode,
              routing: JSON.stringify(useConfigStore.getState().config?.inference),
            }
          : null;
      // Consent and paywalls may finish after the user, provider, mode or originating note changes.
      const isCurrent = (): boolean => {
        if (callerIsCurrent && !callerIsCurrent()) return false;
        if (!context) return true;
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
      if (!isCurrent()) return;
      if (cloudChat && requiresRealAccount(user)) {
        showAccountRequiredAlert('AI chat', { cloudOnly: true });
        return;
      }

      const gateAndRun = (allowCloudFallback = false): void => {
        if (!isCurrent()) return;
        if (!cloudChat) {
          run(allowCloudFallback);
          return;
        }
        registerSuperwallGate({
          placement: SUPERWALL_PLACEMENTS.noteChatStart,
          params: { source },
          requiresAccount: false,
          feature: () => {
            if (isCurrent()) run(allowCloudFallback);
          },
        }).catch(() => {});
      };

      // A local route never reaches Cloud, so there is nothing to consent to.
      if (consentMessage && chatMode !== 'local') {
        if (consentLabels) confirmCloudOnce(consentMessage, () => gateAndRun(true), consentLabels);
        else confirmCloudOnce(consentMessage, () => gateAndRun(true));
        return;
      }

      gateAndRun();
    },
    [chatEnabled, chatMode, cloudChat, registerSuperwallGate, user],
  );

  return { chatEnabled, gate };
}
