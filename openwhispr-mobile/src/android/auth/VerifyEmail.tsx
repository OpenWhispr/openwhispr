import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { requestVerificationEmail } from '@/android/lib/authClient';
import { safeHaptics } from '@/lib/utils';
import { showToast } from '../settings/kit';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { useCountdown } from './ForgotPassword';
import {
  AuthLine,
  AuthTitle,
  ClearButton,
  FieldNote,
  TextButton,
  WhiteButton,
  authLayout,
} from './look';
import { RESEND_SECONDS, formatWait, readRequestOutcome } from './passwordReset';
import { VERIFY_POLL_MS, readVerified } from './emailVerification';
import { useAuthT } from './strings';

/**
 * Verify email (6.1–6.5). The account exists and is signed in; the API emailed a link to
 * openwhispr.com/verify-email when it was created, and the website verifies it. Like desktop,
 * the app asks the API every 5 s (and when it comes back to the front), so verifying anywhere
 * moves on to "Email verified".
 */
export function VerifyEmail({
  email,
  resumed,
  onLeave,
  onContinue,
  onVerified,
}: {
  email: string;
  /** Signed in to an account that never verified (6.4): Resend is ready at once. */
  resumed: boolean;
  /** Use a different email (6.1) or Use another account (6.4). */
  onLeave: () => void;
  /** 6.5's Continue: goes where sign-up was heading. */
  onContinue: () => void;
  /** Told once the API says the email is verified, so the screen drops its Back (6.5). */
  onVerified?: () => void;
}) {
  const t = useAuthT();
  const [verified, setVerified] = useState(false);
  const [sending, setSending] = useState(false);
  // The sign-up email has just gone out; a resumed account may only have an old one.
  const [resendAt, setResendAt] = useState(() =>
    resumed ? 0 : Date.now() + RESEND_SECONDS * 1000,
  );
  const left = useCountdown(resendAt);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    if (verified) return;
    let stopped = false;
    const check = async () => {
      const result = await readVerified();
      if (!stopped && result) setVerified(true);
    };
    void check();
    const timer = setInterval(check, VERIFY_POLL_MS);
    // Back from the browser that verified it: check now rather than within 5 s.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      subscription.remove();
    };
  }, [verified]);

  const resend = useCallback(async () => {
    safeHaptics('light');
    setSending(true);
    let outcome;
    try {
      outcome = readRequestOutcome(await requestVerificationEmail(email));
    } catch {
      outcome = { kind: 'network' as const };
    }
    if (!mounted.current) return;
    setSending(false);
    if (outcome.kind === 'sent') {
      setResendAt(Date.now() + RESEND_SECONDS * 1000);
      showToast(t('linkResent'), 'neutral');
    } else if (outcome.kind === 'rateLimited') {
      setResendAt(Date.now() + outcome.waitSeconds * 1000);
      showToast(t('tooManyTries'), 'neutral');
    } else {
      showToast(t(outcome.kind === 'network' ? 'networkError' : 'signInFailed'), 'neutral');
    }
  }, [email, t]);

  useEffect(() => {
    if (verified) onVerified?.();
  }, [onVerified, verified]);

  if (verified) {
    return (
      <View style={authLayout.content}>
        <View style={authLayout.stack}>
          <AuthTitle>{t('verifiedTitle')}</AuthTitle>
          <AuthLine text={t('verifiedBody', { email })} />
        </View>
        <WhiteButton label={t('continue')} onPress={onContinue} />
      </View>
    );
  }

  return (
    <View style={authLayout.content}>
      <View style={authLayout.stack}>
        <AuthTitle>{t('verifyTitle')}</AuthTitle>
        <AuthLine text={t(resumed ? 'verifyResumedBody' : 'verifyBody', { email })} />
      </View>
      <View style={authLayout.stack}>
        <FieldNote quiet text={t('verifyHint')} />
        <WhiteButton
          label={t('openEmailApp')}
          onPress={() => {
            const opened = AndroidDictation?.openEmailApp?.(t('openEmailApp'));
            if (!opened) showToast(t('noEmailApp'), 'neutral');
          }}
        />
        <ClearButton
          label={left > 0 ? t('resendIn', { time: formatWait(left) }) : t('resendLink')}
          disabled={left > 0 || sending}
          onPress={() => void resend()}
        />
        <TextButton
          label={t(resumed ? 'useAnotherAccount' : 'useDifferentEmail')}
          faded={sending}
          onPress={onLeave}
        />
      </View>
    </View>
  );
}
