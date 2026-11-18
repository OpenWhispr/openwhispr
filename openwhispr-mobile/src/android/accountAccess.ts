import { androidCopy } from '@/lib/androidCopy';
import type { AccountAccessPresentation } from '../lib/accountAccessCore';

const ANDROID_FEATURE_KEYS: Record<string, string> = {
  'cloud transcription': 'workflowAlerts.cloudTranscription',
  'cloud AI': 'editorFeedback.cloudAI',
  'cloud cleanup': 'workflowAlerts.cloudCleanup',
  'AI actions': 'workflowAlerts.aiActions',
  'AI chat': 'workflowAlerts.aiChat',
  'audio import': 'importAudio',
  dictation: 'workflowSettings.dictation',
  referrals: 'referrals',
};

function androidFeature(feature: string): string {
  const key = ANDROID_FEATURE_KEYS[feature];
  // Callers can also supply an already localized feature name.
  return key ? androidCopy(key, feature) : feature;
}

export const androidAccountAccessPresentation: AccountAccessPresentation = {
  localModeAction: 'turn on Local Mode',
  cloudMessage: (feature, anonymous, privateMode, fallback) => {
    return androidCopy(
      `workflowAlerts.${anonymous ? 'createCloud' : 'signInCloud'}${privateMode ? '' : 'OrLocal'}`,
      fallback,
      {
        feature: androidFeature(feature),
        localMode: androidCopy('privateMode', 'Local Mode'),
        account: androidCopy('account', 'Account'),
        models: androidCopy('models', 'Models & processing'),
      },
    );
  },
  cloudOnlyMessage: (feature, anonymous, fallback) => {
    return androidCopy(
      `workflowAlerts.${anonymous ? 'createCloudOnly' : 'signInCloudOnly'}`,
      fallback,
      { feature: androidFeature(feature), localMode: androidCopy('privateMode', 'Local Mode') },
    );
  },
  alertLabels: (anonymous) => ({
    title: anonymous
      ? androidCopy('workflowAlerts.createAccount', 'Create an account')
      : androidCopy('workflowAlerts.signInRequired', 'Sign in required'),
    cancel: androidCopy('cancel', 'Cancel'),
    account: anonymous
      ? androidCopy('workflowAlerts.createAccountAction', 'Create Account')
      : androidCopy('account', 'Account'),
  }),
};
