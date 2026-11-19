import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  View,
  type TextInput as TextInputType,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useAuthStore } from '@/store/useAuthStore';
import { checkUserExists } from '@/lib/authClient';
import { safeHaptics } from '@/lib/utils';
import { showToast } from '@/android/settings/kit';
import {
  AuthBackground,
  AuthField,
  AuthHeader,
  AuthLine,
  AuthTitle,
  ClearButton,
  FieldNote,
  GoogleLogo,
  Legal,
  MicrosoftLogo,
  OrDivider,
  TextButton,
  WhiteButton,
  authLayout,
} from '@/android/auth/look';
import { ForgotPassword } from '@/android/auth/ForgotPassword';
import {
  lastSignInMethod,
  placeAuthError,
  rememberSignInMethod,
  type SignInMethod,
} from '@/android/auth/authErrors';
import { MIN_PASSWORD_LENGTH } from '@/android/auth/passwordReset';
import { useAuthT, type AuthKey } from '@/android/auth/strings';
import { setAuthBackHandler } from '@/android/auth/backPress';

/** Why the app sent someone here; names the title and line (1.2). */
export type AuthReason = 'sync' | 'share' | 'meeting' | 'cloud' | 'plan' | 'referral';

const REASON_COPY: Record<AuthReason, [AuthKey, AuthKey]> = {
  sync: ['reasonSyncTitle', 'reasonSyncBody'],
  share: ['reasonShareTitle', 'reasonShareBody'],
  meeting: ['reasonMeetingTitle', 'reasonMeetingBody'],
  cloud: ['reasonCloudTitle', 'reasonCloudBody'],
  plan: ['reasonPlanTitle', 'reasonPlanBody'],
  referral: ['reasonReferralTitle', 'reasonReferralBody'],
};

export function isAuthReason(value: unknown): value is AuthReason {
  return typeof value === 'string' && value in REASON_COPY;
}

type AuthScreenProps = {
  hideGuestContinue?: boolean;
  onClose?: () => void;
  /**
   * Overrides what "Continue without an account" does. Onboarding uses this to
   * keep the anonymous session it has been running on — the default
   * continueAsGuest() clears the session, which would throw away the user's
   * cloud data and any purchase they just made.
   */
  onGuestContinue?: () => void;
  /** Onboarding shows Back in the logo row; the app shows Close (1.1 / 1.2). */
  variant?: 'onboarding' | 'app';
  reason?: AuthReason;
  /** The account whose session the server rejected: "Sign in again" (2.5). */
  signInAgainEmail?: string;
};

type Step = 'start' | 'signin' | 'signup' | 'again' | 'another' | 'forgot';

export default function AuthScreen({
  hideGuestContinue = false,
  onClose,
  onGuestContinue,
  variant = 'app',
  reason,
  signInAgainEmail,
}: AuthScreenProps = {}) {
  const t = useAuthT();
  const insets = useSafeAreaInsets();
  const {
    user,
    signIn,
    signUp,
    signInWithGoogle,
    signInWithMicrosoft,
    continueAsGuest,
    isLoading,
    loadingProvider,
    error,
    clearError,
  } = useAuthStore();

  const [view, setView] = useState<Step>(signInAgainEmail ? 'again' : 'start');
  const [email, setEmail] = useState(signInAgainEmail ?? '');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [passwordError, setPasswordError] = useState<AuthKey | null>(null);
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const attempted = useRef<{ email: string; method: SignInMethod } | null>(null);
  const passwordRef = useRef<TextInputType>(null);
  const nameRef = useRef<TextInputType>(null);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  // Errors land where they belong: under the password field (1.5) or the dark toast (1.9).
  // A cancelled Google picker reports no error and says nothing.
  useEffect(() => {
    if (!error) return;
    const placed = placeAuthError(error);
    clearError();
    if (placed.place === 'password' && (view === 'signin' || view === 'signup' || view === 'again'))
      setPasswordError(placed.key);
    else showToast('key' in placed ? t(placed.key) : placed.text, 'neutral');
  }, [error, clearError, t, view]);

  // How this account signed in, for the next "Sign in again" (2.5 / 2.5b).
  useEffect(() => {
    const tried = attempted.current;
    if (!user || user.isAnonymous || !tried) return;
    rememberSignInMethod(tried.method === 'email' ? tried.email : user.email, tried.method);
    attempted.current = null;
  }, [user]);

  const go = useCallback(
    (next: Step) => {
      setView(next);
      if (next === 'again' && signInAgainEmail) setEmail(signInAgainEmail);
      setPassword('');
      setName('');
      setPasswordError(null);
      clearError();
      scroll.current?.scrollTo({ y: 0, animated: false });
    },
    [clearError, signInAgainEmail],
  );

  const run = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
      } catch {
        // The store leaves its spinner on when a request throws (offline, timed out).
        useAuthStore.setState({ isLoading: false, loadingProvider: null });
        showToast(t('networkError'), 'neutral');
      }
    },
    [t],
  );

  const handleEmailContinue = useCallback(async () => {
    const address = email.trim();
    if (!address || checkingEmail) return;
    safeHaptics('light');
    setCheckingEmail(true);
    const mode = await checkUserExists(address);
    setCheckingEmail(false);
    go(mode);
    setTimeout(() => (mode === 'signup' ? nameRef : passwordRef).current?.focus(), 100);
  }, [checkingEmail, email, go]);

  const handleSubmit = useCallback(async () => {
    if (!password || isLoading) return;
    const address = email.trim();
    if (view === 'signup' && password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError('passwordTooShort');
      return;
    }
    safeHaptics('medium');
    setPasswordError(null);
    attempted.current = { email: address, method: 'email' };
    await run(() =>
      view === 'signup'
        ? signUp(address, password, name.trim() || undefined)
        : signIn(address, password),
    );
  }, [email, isLoading, name, password, run, signIn, signUp, view]);

  const handleProvider = useCallback(
    async (provider: 'google' | 'microsoft') => {
      safeHaptics('light');
      attempted.current = { email: '', method: provider };
      await run(provider === 'google' ? signInWithGoogle : signInWithMicrosoft);
    },
    [run, signInWithGoogle, signInWithMicrosoft],
  );

  const handleGuest = useCallback(async () => {
    safeHaptics('light');
    if (onGuestContinue) {
      onGuestContinue();
      return;
    }
    await continueAsGuest();
  }, [continueAsGuest, onGuestContinue]);

  const busy = isLoading || checkingEmail;
  const header = (() => {
    switch (view) {
      case 'start':
        return variant === 'onboarding'
          ? { action: 'back' as const, label: t('back'), onPress: onClose }
          : { action: 'close' as const, label: t('close'), onPress: onClose };
      case 'again':
        return { action: 'back' as const, label: t('back'), onPress: onClose };
      case 'another':
        return { action: 'back' as const, label: t('back'), onPress: () => go('again') };
      case 'forgot':
        return {
          action: 'back' as const,
          label: t('back'),
          disabled: resetBusy,
          onPress: () => go(signInAgainEmail ? 'again' : 'signin'),
        };
      default:
        // Back still cancels while signing in (1.6).
        return {
          action: 'back' as const,
          label: t('back'),
          onPress: () => go(signInAgainEmail ? 'another' : 'start'),
        };
    }
  })();

  // The system back gesture steps back inside the screen before it leaves it.
  const backRef = useRef<() => boolean>(() => false);
  backRef.current = () => {
    if (view === 'start' || view === 'again') return false;
    if (!('disabled' in header && header.disabled)) header.onPress?.();
    return true;
  };
  useEffect(() => {
    const press = () => backRef.current();
    setAuthBackHandler(press);
    const subscription = BackHandler.addEventListener('hardwareBackPress', press);
    return () => {
      subscription.remove();
      setAuthBackHandler(null);
    };
  }, []);

  const providers = (only?: SignInMethod) => (
    <View style={authLayout.group}>
      {(['google', 'microsoft'] as const)
        .filter((provider) => !only || only === provider)
        .map((provider) => {
          const loading = loadingProvider === provider;
          return (
            <WhiteButton
              key={provider}
              icon={provider === 'google' ? <GoogleLogo /> : <MicrosoftLogo />}
              label={t(provider === 'google' ? 'continueWithGoogle' : 'continueWithMicrosoft')}
              busy={loading}
              busyLabel={t(provider === 'google' ? 'openingGoogle' : 'openingMicrosoft')}
              faded={busy && !loading}
              onPress={() => void handleProvider(provider)}
            />
          );
        })}
    </View>
  );

  const startView = () => {
    const [titleKey, bodyKey] = reason ? REASON_COPY[reason] : [null, null];
    const typing = emailFocused && keyboardUp;
    const another = view === 'another';
    return (
      <View style={[authLayout.content, { flexGrow: 1 }]}>
        <View style={authLayout.stack}>
          <AuthTitle>
            {another ? t('useAnotherAccount') : titleKey ? t(titleKey) : t('headline')}
          </AuthTitle>
          {another && signInAgainEmail ? (
            <AuthLine text={t('signedOutOf', { email: signInAgainEmail })} />
          ) : bodyKey ? (
            <AuthLine text={t(bodyKey)} />
          ) : null}
        </View>
        <View style={{ flex: 1, minHeight: typing ? 0 : 24 }} />
        {/* The keyboard pushes the stack up; the field and Continue stay above it (1.3). */}
        {typing ? null : providers()}
        {typing ? null : <OrDivider label={t('or')} />}
        <View style={authLayout.stack}>
          <AuthField
            value={email}
            onChangeText={setEmail}
            placeholder={t('emailPlaceholder')}
            accessibilityLabel={t('emailPlaceholder')}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            returnKeyType="next"
            onFocus={() => setEmailFocused(true)}
            onBlur={() => setEmailFocused(false)}
            onSubmitEditing={() => void handleEmailContinue()}
            faded={isLoading}
          />
          {email.trim() ? (
            <WhiteButton
              label={t('continue')}
              busy={checkingEmail}
              faded={isLoading}
              onPress={() => void handleEmailContinue()}
            />
          ) : (
            <ClearButton
              label={t('continue')}
              disabled
              faded={isLoading}
              onPress={() => undefined}
            />
          )}
          {!hideGuestContinue && !another ? (
            <TextButton
              strong
              label={t('continueWithoutAccount')}
              faded={busy}
              onPress={() => void handleGuest()}
            />
          ) : null}
        </View>
        <Legal text={t('legal')} />
      </View>
    );
  };

  const passwordView = () => {
    const signup = view === 'signup';
    const again = view === 'again';
    const method = again && signInAgainEmail ? lastSignInMethod(signInAgainEmail) : 'email';
    const submitting = isLoading && !loadingProvider;
    return (
      <View style={authLayout.content}>
        <View style={authLayout.stack}>
          <AuthTitle>
            {again ? t('signInAgain') : signup ? t('createAccount') : t('welcomeBack')}
          </AuthTitle>
          <AuthLine text={again ? t('signInAgainAs', { email: email.trim() }) : email.trim()} />
        </View>
        <View style={authLayout.stack}>
          {method !== 'email' ? (
            // 2.5b: an account that signs in with Google or Microsoft gets its button.
            providers(method)
          ) : (
            <>
              {signup ? (
                <AuthField
                  ref={nameRef}
                  value={name}
                  onChangeText={setName}
                  placeholder={t('namePlaceholder')}
                  accessibilityLabel={t('namePlaceholder')}
                  autoCapitalize="words"
                  autoCorrect={false}
                  autoComplete="name"
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                  faded={submitting}
                />
              ) : null}
              <View style={authLayout.group}>
                <AuthField
                  ref={passwordRef}
                  value={password}
                  onChangeText={(value) => {
                    setPassword(value);
                    setPasswordError(null);
                  }}
                  placeholder={t(signup ? 'newPasswordPlaceholder' : 'passwordPlaceholder')}
                  accessibilityLabel={t('passwordPlaceholder')}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  returnKeyType="done"
                  onSubmitEditing={() => void handleSubmit()}
                  error={!!passwordError}
                  faded={submitting}
                />
                {passwordError ? <FieldNote error text={t(passwordError)} /> : null}
              </View>
              <WhiteButton
                label={signup ? t('createAccount') : t('signIn')}
                busy={submitting}
                busyLabel={signup ? t('creatingAccount') : t('signingIn')}
                disabled={!password}
                onPress={() => void handleSubmit()}
              />
              {signup ? (
                <TextButton
                  label={t('haveAccount')}
                  faded={submitting}
                  onPress={() => go('signin')}
                />
              ) : (
                <TextButton
                  label={t('forgotPassword')}
                  faded={submitting}
                  onPress={() => go('forgot')}
                />
              )}
            </>
          )}
          {again ? (
            <TextButton
              label={t('useAnotherAccount')}
              faded={isLoading}
              onPress={() => {
                go('another');
                setEmail('');
              }}
            />
          ) : null}
        </View>
        {again ? null : <Legal text={t('legal')} />}
      </View>
    );
  };

  return (
    <AuthBackground>
      <StatusBar style="light" />
      {/* Edge-to-edge Android doesn't resize the window for the keyboard. */}
      <KeyboardAvoidingView style={{ flex: 1, paddingTop: insets.top }} behavior="height">
        <View style={{ paddingHorizontal: 16, marginBottom: 20 }}>
          <AuthHeader {...header} />
        </View>
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            // The keyboard already covers the navigation bar.
            paddingBottom: keyboardUp ? 8 : Math.max(insets.bottom, 8),
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {view === 'forgot' ? (
            <ForgotPassword
              initialEmail={email}
              onBusyChange={setResetBusy}
              onBackToSignIn={() => go(signInAgainEmail ? 'again' : 'signin')}
            />
          ) : view === 'start' || view === 'another' ? (
            startView()
          ) : (
            passwordView()
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </AuthBackground>
  );
}
