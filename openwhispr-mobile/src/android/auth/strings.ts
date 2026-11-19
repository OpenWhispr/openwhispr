import i18n from '../strings';
import { useTranslation } from 'react-i18next';
import { authTranslations } from './translations';

// Sign-in copy lives here rather than in the shared locale files, which the iOS app loads.
export const authEnglish = {
  back: 'Back',
  close: 'Close sign in',
  headline: 'Privacy-first\nVoice-to-text AI',
  continueWithGoogle: 'Continue with Google',
  continueWithMicrosoft: 'Continue with Microsoft',
  openingGoogle: 'Opening Google…',
  openingMicrosoft: 'Opening Microsoft…',
  or: 'or',
  emailPlaceholder: 'Email address',
  continue: 'Continue',
  continueWithoutAccount: 'Continue without an account',
  legal: 'By continuing, you agree to our Terms of Service and Privacy Policy',
  welcomeBack: 'Welcome back',
  createAccount: 'Create account',
  passwordPlaceholder: 'Password',
  namePlaceholder: 'Full name (optional)',
  newPasswordPlaceholder: 'Create password (8+ chars)',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  creatingAccount: 'Creating account…',
  forgotPassword: 'Forgot password?',
  haveAccount: 'Already have an account? Sign in',
  noAccount: 'Don’t have an account? Sign up',
  wrongPassword: 'That password doesn’t match. Try again or reset it.',
  passwordTooShort: 'Use at least 8 characters.',
  accountExists: 'That email already has an account. Sign in instead.',
  networkError: 'Couldn’t reach OpenWhispr. Check your connection.',
  signInFailed: 'Sign in didn’t work. Try again.',
  signInAgain: 'Sign in again',
  signInAgainAs: 'as <b>{{email}}</b>',
  continueWithProvider: 'Continue with {{provider}}',
  useAnotherAccount: 'Use another account',
  signedOutOf: 'You were signed out of {{email}}. Sign in with a different account.',
  reasonSyncTitle: 'Back up and sync your notes',
  reasonSyncBody: 'Your account keeps your notes safe and works on your computer too.',
  reasonShareTitle: 'Sign in to share notes',
  reasonShareBody: 'Shared notes get a link you can send. Your account works on your computer too.',
  reasonMeetingTitle: 'Sign in to record meetings',
  reasonMeetingBody:
    'Meetings are transcribed in the cloud. Your account works on your computer too.',
  reasonCloudTitle: 'Sign in to use Cloud',
  reasonCloudBody:
    'Cloud transcribes and cleans up your words. Your account works on your computer too.',
  reasonPlanTitle: 'Sign in to see your plan',
  reasonPlanBody: 'Your plan belongs to your account and works on your computer too.',
  reasonReferralTitle: 'Sign in to invite friends',
  reasonReferralBody: 'Your invite link belongs to your account.',
  resetTitle: 'Reset your password',
  resetBody: 'We’ll email you a link to set a new password.',
  sendResetLink: 'Send reset link',
  sending: 'Sending…',
  backToSignIn: 'Back to sign in',
  notAnEmail: 'Enter a full email address, like name@example.com.',
  checkEmailTitle: 'Check your email',
  checkEmailBody:
    'If <b>{{email}}</b> has an OpenWhispr account, a reset link is on its way. It works for 1 hour.',
  checkEmailHint: 'Didn’t get it? Check spam, or send it again.',
  openEmailApp: 'Open email app',
  noEmailApp: 'No email app found on this phone.',
  resendIn: 'Resend in {{time}}',
  resendLink: 'Resend link',
  useDifferentEmail: 'Use a different email',
  linkResent: 'New link sent. Use the newest email.',
  tooManyTries: 'Too many tries. Wait a few minutes.',
  newPasswordTitle: 'Set a new password',
  newPasswordFor: 'For <b>{{email}}</b>.',
  newPasswordField: 'New password',
  showPassword: 'Show',
  hidePassword: 'Hide',
  showPasswordLabel: 'Show password',
  hidePasswordLabel: 'Hide password',
  atLeast8: 'At least 8 characters',
  savePassword: 'Save password',
  saving: 'Saving…',
  linkExpiredTitle: 'This link has expired',
  linkExpiredBody: 'Reset links work once, for 1 hour. Send a new one and open the newest email.',
  sendNewLink: 'Send a new link',
  passwordUpdatedTitle: 'Password updated',
  passwordUpdatedBody: 'You’re signed in. Use the new password on your computer too.',
  passwordUpdatedSignIn: 'Sign in with your new password. Use it on your computer too.',
};

export type AuthKey = keyof typeof authEnglish;
export const AUTH_NAMESPACE = 'androidAuth';

i18n.addResourceBundle('en', AUTH_NAMESPACE, authEnglish, true, false);
for (const [language, strings] of Object.entries(authTranslations))
  i18n.addResourceBundle(language, AUTH_NAMESPACE, strings, true, false);

export type AuthT = (key: AuthKey, options?: Record<string, unknown>) => string;

export function useAuthT(): AuthT {
  const { t } = useTranslation(AUTH_NAMESPACE);
  return (key, options) => t(key, options) as string;
}
