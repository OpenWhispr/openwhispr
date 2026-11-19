import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { requestPasswordResetEmail } from '@/lib/authClient.android';
import { safeHaptics } from '@/lib/utils';
import { showToast } from '../settings/kit';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import {
  AuthField,
  AuthLine,
  AuthTitle,
  ClearButton,
  FieldNote,
  TextButton,
  WhiteButton,
  authLayout,
} from './look';
import {
  RESEND_SECONDS,
  RESET_REDIRECT_URL,
  formatWait,
  looksLikeEmail,
  readRequestOutcome,
  rememberResetEmail,
  type ResetRequestOutcome,
} from './passwordReset';
import { useAuthT } from './strings';

async function sendResetLink(email: string): Promise<ResetRequestOutcome> {
  try {
    return readRequestOutcome(await requestPasswordResetEmail(email, RESET_REDIRECT_URL));
  } catch {
    return { kind: 'network' };
  }
}

/** Seconds left until `until`, ticking once a second; 0 once it has passed. */
function useCountdown(until: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * Forgot password (3.1–3.6) on Better Auth's /request-password-reset. The answer never says
 * whether the email has an account, so "Check your email" reads the same either way.
 */
export function ForgotPassword({
  initialEmail,
  title,
  body,
  sendLabel,
  onBackToSignIn,
  onBusyChange,
}: {
  initialEmail: string;
  /** 3.10 reuses this form with its own title, line and button. */
  title?: string;
  body?: string;
  sendLabel?: string;
  onBackToSignIn: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useAuthT();
  const [email, setEmail] = useState(initialEmail);
  const [stage, setStage] = useState<'form' | 'sent'>('form');
  const [sending, setSending] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const left = useCountdown(resendAt);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => onBusyChange?.(sending), [onBusyChange, sending]);

  const send = useCallback(
    async (again: boolean) => {
      const address = email.trim();
      if (!looksLikeEmail(address)) {
        setInvalid(true);
        return;
      }
      safeHaptics('light');
      setSending(true);
      const outcome = await sendResetLink(address);
      if (!mounted.current) return;
      setSending(false);
      if (outcome.kind === 'sent') {
        rememberResetEmail(address);
        setResendAt(Date.now() + RESEND_SECONDS * 1000);
        setStage('sent');
        if (again) showToast(t('linkResent'), 'neutral');
      } else if (outcome.kind === 'rateLimited') {
        // The pill waits it out; the toast says why (3.6). No error screen.
        setResendAt(Date.now() + outcome.waitSeconds * 1000);
        setStage('sent');
        showToast(t('tooManyTries'), 'neutral');
      } else {
        showToast(t(outcome.kind === 'network' ? 'networkError' : 'signInFailed'), 'neutral');
      }
    },
    [email, t],
  );

  if (stage === 'sent') {
    return (
      <View style={authLayout.content}>
        <View style={authLayout.stack}>
          <AuthTitle>{t('checkEmailTitle')}</AuthTitle>
          <AuthLine text={t('checkEmailBody', { email: email.trim() })} />
        </View>
        <View style={authLayout.stack}>
          <FieldNote quiet text={t('checkEmailHint')} />
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
            onPress={() => void send(true)}
          />
          <TextButton
            label={t('useDifferentEmail')}
            onPress={() => setStage('form')}
            faded={sending}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={authLayout.content}>
      <View style={authLayout.stack}>
        <AuthTitle>{title ?? t('resetTitle')}</AuthTitle>
        <AuthLine text={body ?? t('resetBody')} />
      </View>
      <View style={authLayout.stack}>
        <View style={authLayout.group}>
          <AuthField
            value={email}
            onChangeText={(value) => {
              setEmail(value);
              setInvalid(false);
            }}
            placeholder={t('emailPlaceholder')}
            accessibilityLabel={t('emailPlaceholder')}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            returnKeyType="send"
            onSubmitEditing={() => void send(false)}
            error={invalid}
            faded={sending}
          />
          {invalid ? <FieldNote error text={t('notAnEmail')} /> : null}
        </View>
        <WhiteButton
          label={sendLabel ?? t('sendResetLink')}
          busy={sending}
          busyLabel={t('sending')}
          disabled={!email.trim()}
          onPress={() => void send(false)}
        />
        <TextButton label={t('backToSignIn')} onPress={onBackToSignIn} faded={sending} />
      </View>
    </View>
  );
}
