import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useAuthStore } from '@/android/store/useAuthStore';
import { ForgotPassword } from './ForgotPassword';
import { VerifyEmail } from './VerifyEmail';
import {
  AuthBackground,
  AuthHeader,
  AuthLine,
  AuthTitle,
  WhiteButton,
  authLayout,
  useAuthColors,
} from './look';
import { readVerified, tokenEmail, verifyEmailToken } from './emailVerification';
import { requestVerificationEmail } from '@/android/lib/authClient';
import { useAuthT } from './strings';

type Stage = 'checking' | 'verified' | 'expired' | 'offline' | 'sent';

/**
 * Opened by the link in "Verify your email" (openwhispr.com/android-verify-email?token=…), so
 * there is no Back. Verifies in place: Email verified (6.5), or This link has expired (6.6),
 * whose Send a new link goes to Verify your email (6.1). An account that is verified already
 * skips 6.6 and shows 6.5.
 */
export function VerifyLinkScreen({
  token,
  onContinue,
  onSignIn,
}: {
  token?: string;
  /** Where sign-up was heading. */
  onContinue: () => void;
  onSignIn: () => void;
}) {
  const t = useAuthT();
  const insets = useSafeAreaInsets();
  const authColors = useAuthColors();
  const user = useAuthStore((state) => state.user);
  // Signed in as the account the link is for. Someone signed in as another account (or
  // signed out) is told to sign in; the phone's session is never switched.
  const linkEmail = tokenEmail(token);
  const signedIn =
    !!user && !user.isAnonymous && !!linkEmail && user.email.toLowerCase() === linkEmail;
  const [stage, setStage] = useState<Stage>('checking');
  const [sentTo, setSentTo] = useState('');
  const started = useRef(false);

  const check = useCallback(async () => {
    setStage('checking');
    const outcome = token ? await verifyEmailToken(token) : 'invalid';
    if (outcome === 'verified') return setStage('verified');
    // A used link for an account that is verified anyway: say so rather than "expired".
    if (signedIn && (await readVerified())) return setStage('verified');
    // A rate limit, a server error or no connection says nothing about the link: offer to try
    // the same link again, never a new one (which would spend the resend limit).
    setStage(outcome === 'network' ? 'offline' : 'expired');
  }, [signedIn, token]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void check();
  }, [check]);

  // The signed-in account now counts as verified, so the sign-in screens let it go on.
  const finish = useCallback(() => {
    const current = useAuthStore.getState().user;
    if (current && !current.isAnonymous && !current.emailVerified)
      useAuthStore.setState({ user: { ...current, emailVerified: true } });
    onContinue();
  }, [onContinue]);

  let body: React.ReactNode;
  if (stage === 'checking') {
    body = (
      <View style={authLayout.content}>
        <AuthTitle>{t('verifying')}</AuthTitle>
        <ActivityIndicator color={authColors.onBlue} />
      </View>
    );
  } else if (stage === 'verified') {
    body = (
      <View style={authLayout.content}>
        <View style={authLayout.stack}>
          <AuthTitle>{t('verifiedTitle')}</AuthTitle>
          <AuthLine
            text={signedIn ? t('verifiedBody', { email: user.email }) : t('verifiedSignIn')}
          />
        </View>
        <WhiteButton
          label={signedIn ? t('continue') : t('signIn')}
          onPress={signedIn ? finish : onSignIn}
        />
      </View>
    );
  } else if (stage === 'offline') {
    body = (
      <View style={authLayout.content}>
        <View style={authLayout.stack}>
          <AuthTitle>{t('verifyOfflineTitle')}</AuthTitle>
          <AuthLine text={t('networkError')} />
        </View>
        <WhiteButton label={t('tryAgain')} onPress={() => void check()} />
      </View>
    );
  } else if (stage === 'sent') {
    body = <VerifyEmail email={sentTo} resumed={false} onLeave={onSignIn} onContinue={finish} />;
  } else {
    body = (
      <ForgotPassword
        initialEmail={signedIn ? user.email : (linkEmail ?? '')}
        title={t('linkExpiredTitle')}
        body={t('verifyExpiredBody')}
        sendLabel={t('sendNewLink')}
        sendRequest={requestVerificationEmail}
        onSent={(email) => {
          setSentTo(email);
          setStage('sent');
        }}
        onBackToSignIn={onSignIn}
      />
    );
  }

  return (
    <AuthBackground>
      <StatusBar style="light" />
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={{ paddingHorizontal: 16, marginBottom: 20 }}>
          <AuthHeader label={t('back')} />
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: Math.max(insets.bottom, 8) }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {body}
        </ScrollView>
      </View>
    </AuthBackground>
  );
}
