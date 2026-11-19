import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { resetPasswordWithToken } from '@/lib/authClient.android';
import { useAuthStore } from '@/store/useAuthStore';
import { safeHaptics } from '@/lib/utils';
import { showToast } from '../settings/kit';
import { ForgotPassword } from './ForgotPassword';
import {
  AuthBackground,
  AuthField,
  AuthHeader,
  AuthLine,
  AuthTitle,
  FieldNote,
  WhiteButton,
  authLayout,
} from './look';
import {
  MIN_PASSWORD_LENGTH,
  forgetResetEmail,
  pendingResetEmail,
  readResetOutcome,
} from './passwordReset';
import { rememberSignInMethod } from './authErrors';
import { useAuthT } from './strings';

type Stage = 'form' | 'expired' | 'done';

/**
 * Opened by the link in the reset email (3.7–3.11), so there is no Back: the way out is Save,
 * or Back to sign in on an expired link. On success the app signs in with the new password
 * when this phone asked for the link; otherwise it says to sign in.
 */
export function ResetPasswordScreen({
  token,
  invalid,
  onSignIn,
  onContinue,
}: {
  token?: string;
  /** The API redirected with ?error=INVALID_TOKEN: old, used or mistyped. */
  invalid: boolean;
  onSignIn: () => void;
  onContinue: () => void;
}) {
  const t = useAuthT();
  const insets = useSafeAreaInsets();
  const signIn = useAuthStore((state) => state.signIn);
  const [email] = useState(() => pendingResetEmail());
  const [stage, setStage] = useState<Stage>(invalid || !token ? 'expired' : 'form');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [tooShort, setTooShort] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const save = useCallback(async () => {
    if (!token || saving) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setTooShort(true);
      return;
    }
    safeHaptics('medium');
    setSaving(true);
    let outcome;
    try {
      outcome = readResetOutcome(await resetPasswordWithToken(password, token));
    } catch {
      outcome = { kind: 'network' as const };
    }
    if (outcome.kind === 'saved' && email) {
      // No second sign-in: the new password signs this phone in.
      try {
        await signIn(email, password);
      } catch {
        useAuthStore.setState({ isLoading: false });
      }
      const user = useAuthStore.getState().user;
      const ok = !!user && !user.isAnonymous && user.email.toLowerCase() === email.toLowerCase();
      if (ok) rememberSignInMethod(email, 'email');
      // The sign-in's own error has nowhere to show here; the success screen says what to do.
      useAuthStore.getState().clearError();
      if (mounted.current) setSignedIn(ok);
    }
    if (!mounted.current) return;
    setSaving(false);
    if (outcome.kind === 'saved') {
      forgetResetEmail();
      setStage('done');
    } else if (outcome.kind === 'invalidToken') setStage('expired');
    else if (outcome.kind === 'tooShort') setTooShort(true);
    else
      showToast(
        t(
          outcome.kind === 'rateLimited'
            ? 'tooManyTries'
            : outcome.kind === 'network'
              ? 'networkError'
              : 'signInFailed',
        ),
        'neutral',
      );
  }, [email, password, saving, signIn, t, token]);

  const met = password.length >= MIN_PASSWORD_LENGTH;
  return (
    <AuthBackground>
      <StatusBar style="light" />
      {/* Edge-to-edge Android doesn't resize the window for the keyboard. */}
      <KeyboardAvoidingView style={{ flex: 1, paddingTop: insets.top }} behavior="height">
        <View style={{ paddingHorizontal: 16, marginBottom: 20 }}>
          <AuthHeader label={t('back')} />
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingBottom: Math.max(insets.bottom, 8),
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {stage === 'expired' ? (
            <ForgotPassword
              initialEmail={email ?? ''}
              title={t('linkExpiredTitle')}
              body={t('linkExpiredBody')}
              sendLabel={t('sendNewLink')}
              onBackToSignIn={onSignIn}
            />
          ) : stage === 'done' ? (
            <View style={authLayout.content}>
              <View style={authLayout.stack}>
                <AuthTitle>{t('passwordUpdatedTitle')}</AuthTitle>
                <AuthLine text={t(signedIn ? 'passwordUpdatedBody' : 'passwordUpdatedSignIn')} />
              </View>
              <WhiteButton
                label={signedIn ? t('continue') : t('signIn')}
                onPress={signedIn ? onContinue : onSignIn}
              />
            </View>
          ) : (
            <View style={authLayout.content}>
              <View style={authLayout.stack}>
                <AuthTitle>{t('newPasswordTitle')}</AuthTitle>
                {email ? <AuthLine text={t('newPasswordFor', { email })} /> : null}
              </View>
              <View style={authLayout.stack}>
                <View style={authLayout.group}>
                  <AuthField
                    value={password}
                    onChangeText={(value) => {
                      setPassword(value);
                      setTooShort(false);
                    }}
                    placeholder={t('newPasswordField')}
                    accessibilityLabel={t('newPasswordField')}
                    secureTextEntry={!shown}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="new-password"
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={() => void save()}
                    error={tooShort}
                    faded={saving}
                    reveal={{
                      shown,
                      onToggle: () => setShown((value) => !value),
                      show: t('showPassword'),
                      hide: t('hidePassword'),
                      showLabel: t('showPasswordLabel'),
                      hideLabel: t('hidePasswordLabel'),
                    }}
                  />
                  {/* The rule sits quietly under the field and ticks when met; red only after Save. */}
                  {tooShort ? (
                    <FieldNote error text={t('passwordTooShort')} />
                  ) : (
                    <View style={{ opacity: saving ? 0.5 : met ? 1 : 0.72 }}>
                      <FieldNote text={`${met ? '✓ ' : ''}${t('atLeast8')}`} />
                    </View>
                  )}
                </View>
                <WhiteButton
                  label={t('savePassword')}
                  busy={saving}
                  busyLabel={t('saving')}
                  disabled={!password}
                  onPress={() => void save()}
                />
              </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </AuthBackground>
  );
}
