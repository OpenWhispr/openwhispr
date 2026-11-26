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
    (run, { consentMessage, source }) => {
      if (cloudChat && requiresRealAccount(user)) {
        showAccountRequiredAlert('AI chat', { cloudOnly: true });
        return;
      }

      const gateAndRun = (allowCloudFallback = false): void => {
        if (!cloudChat) {
          run(allowCloudFallback);
          return;
        }
        registerSuperwallGate({
          placement: SUPERWALL_PLACEMENTS.noteChatStart,
          params: { source },
          requiresAccount: false,
          feature: () => run(allowCloudFallback),
        }).catch(() => {});
      };

      // A local route never reaches Cloud, so there is nothing to consent to.
      if (consentMessage && chatMode !== 'local') {
        confirmCloudOnce(consentMessage, () => gateAndRun(true));
        return;
      }

      gateAndRun();
    },
    [chatMode, cloudChat, registerSuperwallGate, user],
  );

  return { chatEnabled, gate };
}
