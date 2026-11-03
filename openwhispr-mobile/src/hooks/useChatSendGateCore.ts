import { useCallback } from 'react';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { requiresRealAccount, showAccountRequiredAlert } from '@/lib/accountAccess';
import { confirmCloudOnce } from '@/lib/alerts';
import { isChatEnabled } from '@/lib/dictationAgent';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';

export type ChatSendGateOptions = {
  /** Shown before the request leaves the phone; null sends without asking. */
  consentMessage: string | null;
  source: 'note_chat' | 'chat_tab';
};

export type ChatSendGate<Options extends ChatSendGateOptions = ChatSendGateOptions> = {
  chatEnabled: boolean;
  gate: (run: (allowCloudFallback: boolean) => void, options: Options) => void;
};

export interface ChatSendGateLifecycle<Options extends ChatSendGateOptions> {
  capture: (enabled: boolean, options: Options) => (() => boolean) | null;
  confirm: (message: string, onConfirm: () => void, options: Options) => void;
}

export function useChatSendGateCore<Options extends ChatSendGateOptions = ChatSendGateOptions>(
  lifecycle?: ChatSendGateLifecycle<Options>,
): ChatSendGate<Options> {
  const user = useAuthStore((s) => s.user);
  const { register: registerSuperwallGate } = useSuperwallGate();
  const chatMode = useConfigStore((s) => s.config?.inference?.noteChat?.mode);
  const chatEnabled = useConfigStore((s) => isChatEnabled(s.config));
  // Only an unset or OpenWhispr chat route reaches Cloud, so only it needs an account and the paywall.
  const cloudChat = chatMode !== 'providers' && chatMode !== 'local';
  const enabledForGate = lifecycle ? chatEnabled : true;
  const gate = useCallback<ChatSendGate<Options>['gate']>(
    (run, options) => {
      const { consentMessage, source } = options;
      const isCurrent = lifecycle?.capture(enabledForGate, options);
      if (isCurrent === null || (isCurrent && !isCurrent())) return;
      if (cloudChat && requiresRealAccount(user)) {
        showAccountRequiredAlert('AI chat', { cloudOnly: true });
        return;
      }
      const gateAndRun = (allowCloudFallback = false): void => {
        if (isCurrent && !isCurrent()) return;
        if (!cloudChat) {
          run(allowCloudFallback);
          return;
        }
        registerSuperwallGate({
          placement: SUPERWALL_PLACEMENTS.noteChatStart,
          params: { source },
          requiresAccount: false,
          feature: isCurrent
            ? () => {
                if (isCurrent()) run(allowCloudFallback);
              }
            : () => run(allowCloudFallback),
        }).catch(() => {});
      };
      // A local route never reaches Cloud, so there is nothing to consent to.
      if (consentMessage && chatMode !== 'local') {
        if (lifecycle) lifecycle.confirm(consentMessage, () => gateAndRun(true), options);
        else confirmCloudOnce(consentMessage, () => gateAndRun(true));
        return;
      }
      gateAndRun();
    },
    [chatMode, cloudChat, registerSuperwallGate, user, lifecycle, enabledForGate],
  );
  return { chatEnabled, gate };
}
