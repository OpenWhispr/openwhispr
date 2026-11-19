import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  TextInput,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  StyleSheet,
  type TextInput as TextInputType,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as AppleAuthentication from 'expo-apple-authentication';
import Svg, { Path } from 'react-native-svg';
import { useAuthStore } from '@/store/useAuthStore';
import { checkUserExists } from '@/lib/authClient';
import { safeHaptics } from '@/lib/utils';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { AppFont } from '@/lib/fonts';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
import { gloss, glossPressed, home } from '@/android/home/kit';
import { edge, edgeField, look } from '@/android/settings/look';

type AuthMode = null | 'signin' | 'signup';
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
};

// Full-pill radius shared by every login button.
const BUTTON_HEIGHT = 50;
const PILL_RADIUS = BUTTON_HEIGHT / 2;
const PLACEHOLDER_COLOR = home.tertiary;

function GoogleLogo() {
  return (
    <View style={styles.providerLogoBox}>
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          fill="#4285F4"
        />
        <Path
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          fill="#34A853"
        />
        <Path
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
          fill="#FBBC05"
        />
        <Path
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
          fill="#EA4335"
        />
      </Svg>
    </View>
  );
}

function MicrosoftLogo() {
  return (
    <View style={styles.providerLogoBox}>
      <Svg width={20} height={20} viewBox="0 0 23 23">
        <Path d="M0 0h11v11H0z" fill="#F25022" />
        <Path d="M12 0h11v11H12z" fill="#7FBA00" />
        <Path d="M0 12h11v11H0z" fill="#00A4EF" />
        <Path d="M12 12h11v11H12z" fill="#FFB900" />
      </Svg>
    </View>
  );
}

function ProviderButton({
  logo,
  label,
  provider,
  onPress,
}: {
  logo: React.ReactNode;
  label: string;
  provider: 'apple' | 'google' | 'microsoft';
  onPress: () => void;
}) {
  const isLoading = useAuthStore((s) => s.isLoading);
  const loadingProvider = useAuthStore((s) => s.loadingProvider);
  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      style={({ pressed }) => [
        styles.providerButton,
        isLoading ? styles.disabled : pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {loadingProvider === provider ? (
        <ActivityIndicator size="small" color={home.text} />
      ) : (
        <>
          {logo}
          <Text style={styles.providerButtonText}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

export default function AuthScreen({
  hideGuestContinue = false,
  onClose,
  onGuestContinue,
}: AuthScreenProps = {}) {
  const insets = useSafeAreaInsets();
  const {
    signIn,
    signUp,
    signInWithGoogle,
    signInWithApple,
    signInWithMicrosoft,
    continueAsGuest,
    isLoading,
    error,
    clearError,
  } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const [isCheckingEmail, setIsCheckingEmail] = useState(false);
  const [isAppleAvailable, setIsAppleAvailable] = useState(false);

  const passwordRef = useRef<TextInputType>(null);
  const nameRef = useRef<TextInputType>(null);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    AppleAuthentication.isAvailableAsync()
      .then(setIsAppleAvailable)
      .catch(() => setIsAppleAvailable(false));
  }, []);

  const handleEmailContinue = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    safeHaptics('light');
    setIsCheckingEmail(true);
    clearError();
    const mode = await checkUserExists(trimmed);
    setAuthMode(mode);
    setIsCheckingEmail(false);
    setTimeout(() => {
      if (mode === 'signup') {
        nameRef.current?.focus();
      } else {
        passwordRef.current?.focus();
      }
    }, 100);
  }, [email, clearError]);

  const handleSubmit = useCallback(async () => {
    if (!password) return;
    safeHaptics('medium');
    if (authMode === 'signin') {
      await signIn(email.trim(), password);
    } else if (authMode === 'signup') {
      await signUp(email.trim(), password, name.trim() || undefined);
    }
  }, [authMode, email, password, name, signIn, signUp]);

  const handleGoogle = useCallback(async () => {
    safeHaptics('light');
    await signInWithGoogle();
  }, [signInWithGoogle]);

  const handleApple = useCallback(async () => {
    if (isLoading) return;
    safeHaptics('light');
    await signInWithApple();
  }, [isLoading, signInWithApple]);

  const handleMicrosoft = useCallback(async () => {
    safeHaptics('light');
    await signInWithMicrosoft();
  }, [signInWithMicrosoft]);

  const handleGuest = useCallback(async () => {
    safeHaptics('light');
    if (onGuestContinue) {
      onGuestContinue();
      return;
    }
    await continueAsGuest();
  }, [continueAsGuest, onGuestContinue]);

  const handleBack = useCallback(() => {
    setAuthMode(null);
    setPassword('');
    setName('');
    clearError();
  }, [clearError]);

  const handleToggleMode = useCallback(() => {
    setAuthMode((prev) => (prev === 'signin' ? 'signup' : 'signin'));
    setPassword('');
    clearError();
  }, [clearError]);

  const headerTitle =
    authMode === 'signin' ? 'Welcome back' : authMode === 'signup' ? 'Create account' : null;

  return (
    <View style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: insets.top + 20, paddingBottom: Math.max(insets.bottom, 16) },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {/* Brand lockup, top-left */}
          <View style={styles.brandRow}>
            <OpenWhisprMark size={32} color={home.accent} />
            <Text style={styles.brandWord}>OpenWhispr</Text>
          </View>
          {onClose ? (
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [
                styles.closeButton,
                Platform.OS === 'android' && { top: insets.top + 18 },
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Close sign in"
              hitSlop={8}
            >
              <SystemIcon name="xmark" mdName="X" size={18} color={home.text} />
            </Pressable>
          ) : null}

          {authMode ? (
            <View style={styles.authHeader}>
              <Pressable
                onPress={handleBack}
                style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="Go back"
                hitSlop={8}
              >
                <SystemIcon name="chevron.left" mdName="ChevronLeft" size={20} color={home.text} />
              </Pressable>
              <Text accessibilityRole="header" style={styles.headline}>
                {headerTitle}
              </Text>
              {email.trim() ? <Text style={styles.headerSub}>{email.trim()}</Text> : null}
            </View>
          ) : (
            <Text accessibilityRole="header" style={styles.headline}>
              Privacy-first{'\n'}voice-to-text AI
            </Text>
          )}

          {/* Spacer pushes the action stack to the bottom (collapses with keyboard) */}
          <View style={styles.spacer} />

          <View>
            {!authMode && (
              <View style={styles.formGroup}>
                {Platform.OS === 'ios' && isAppleAvailable ? (
                  <ProviderButton
                    provider="apple"
                    label="Continue with Apple"
                    onPress={handleApple}
                    logo={
                      <View style={styles.providerLogoBox}>
                        <SystemIcon name="apple.logo" mdName="Apple" size={19} color="#000000" />
                      </View>
                    }
                  />
                ) : null}

                <ProviderButton
                  provider="google"
                  label="Continue with Google"
                  onPress={handleGoogle}
                  logo={<GoogleLogo />}
                />

                <ProviderButton
                  provider="microsoft"
                  label="Continue with Microsoft"
                  onPress={handleMicrosoft}
                  logo={<MicrosoftLogo />}
                />

                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>or</Text>
                  <View style={styles.dividerLine} />
                </View>

                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Email address"
                  placeholderTextColor={PLACEHOLDER_COLOR}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  returnKeyType="next"
                  onSubmitEditing={handleEmailContinue}
                  style={styles.input}
                  accessibilityLabel="Email address"
                />
                <Pressable
                  onPress={handleEmailContinue}
                  disabled={!email.trim() || isCheckingEmail}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    !email.trim() || isCheckingEmail
                      ? styles.disabled
                      : pressed && styles.primaryPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Continue with email"
                >
                  {isCheckingEmail ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.primaryButtonText}>Continue</Text>
                  )}
                </Pressable>

                {!hideGuestContinue ? (
                  <Pressable
                    onPress={handleGuest}
                    disabled={isLoading}
                    style={({ pressed }) => [styles.guestButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Continue without an account"
                  >
                    <Text style={styles.guestButtonText}>Continue without an account</Text>
                  </Pressable>
                ) : null}
              </View>
            )}

            {authMode && (
              <View style={styles.formGroup}>
                {authMode === 'signup' && (
                  <TextInput
                    ref={nameRef}
                    value={name}
                    onChangeText={setName}
                    placeholder="Full name (optional)"
                    placeholderTextColor={PLACEHOLDER_COLOR}
                    autoCapitalize="words"
                    autoCorrect={false}
                    autoComplete="name"
                    returnKeyType="next"
                    onSubmitEditing={() => passwordRef.current?.focus()}
                    style={styles.input}
                    accessibilityLabel="Full name"
                  />
                )}
                <TextInput
                  ref={passwordRef}
                  value={password}
                  onChangeText={setPassword}
                  placeholder={authMode === 'signup' ? 'Create password (8+ chars)' : 'Password'}
                  placeholderTextColor={PLACEHOLDER_COLOR}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                  returnKeyType="done"
                  onSubmitEditing={handleSubmit}
                  style={styles.input}
                  accessibilityLabel="Password"
                />
                <Pressable
                  onPress={handleSubmit}
                  disabled={!password || isLoading}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    !password || isLoading ? styles.disabled : pressed && styles.primaryPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={authMode === 'signin' ? 'Sign in' : 'Create account'}
                >
                  {isLoading ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      {authMode === 'signin' ? 'Sign In' : 'Create Account'}
                    </Text>
                  )}
                </Pressable>

                <Pressable
                  onPress={handleToggleMode}
                  style={({ pressed }) => [styles.toggleButton, pressed && styles.pressed]}
                  accessibilityRole="button"
                >
                  <Text style={styles.toggleText}>
                    {authMode === 'signin'
                      ? "Don't have an account? Sign up"
                      : 'Already have an account? Sign in'}
                  </Text>
                </Pressable>
              </View>
            )}

            {error ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Text style={styles.legal}>
              By continuing, you agree to our Terms of Service and Privacy Policy
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: look.canvas,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
  },

  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 32,
  },
  brandWord: {
    fontSize: 22,
    fontWeight: '700',
    color: home.text,
    letterSpacing: -0.4,
  },
  // The settings header's round button: white, the glass edge, an ink glyph.
  closeButton: {
    ...edge,
    position: 'absolute',
    top: 18,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },

  headline: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700',
    color: home.text,
    marginTop: 28,
  },
  authHeader: {
    marginTop: 28,
  },
  headerSub: {
    fontSize: 13,
    lineHeight: 18,
    color: home.secondary,
    marginTop: 8,
  },
  backButton: {
    ...edge,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },

  spacer: {
    flex: 1,
    minHeight: 32,
  },

  formGroup: {
    gap: 20,
  },

  providerLogoBox: {
    // Pinned to a fixed left column so all three provider logos line up
    // vertically, while the label stays centered in the button.
    position: 'absolute',
    left: 20,
    top: 0,
    bottom: 0,
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerButton: {
    ...edge,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: BUTTON_HEIGHT,
    borderRadius: PILL_RADIUS,
  },
  providerButtonText: {
    fontSize: 15,
    lineHeight: 22,
    color: home.text,
    fontWeight: '500',
  },

  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: look.hairline,
  },
  dividerText: {
    fontSize: 13,
    lineHeight: 18,
    color: home.secondary,
  },

  input: {
    ...edgeField,
    paddingVertical: 13,
    paddingHorizontal: 16,
    fontFamily: AppFont.regular,
    fontSize: 16,
    lineHeight: 21,
    color: home.text,
  },

  guestButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  guestButtonText: {
    fontSize: 16,
    lineHeight: 21,
    color: home.accent,
  },

  // The brand glass, flat: no lift. Disabled is the same glass at half strength.
  primaryButton: {
    ...gloss,
    height: BUTTON_HEIGHT,
    borderRadius: PILL_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryPressed: glossPressed,
  primaryButtonText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
    color: '#FFFFFF',
  },

  toggleButton: {
    minHeight: 44,
    justifyContent: 'center',
  },
  toggleText: {
    fontSize: 16,
    lineHeight: 21,
    color: home.accent,
  },

  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.7,
  },

  errorBanner: {
    ...edgeField,
    marginTop: 14,
    padding: 12,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
    color: look.error,
  },

  legal: {
    fontSize: 13,
    lineHeight: 18,
    color: home.secondary,
    marginTop: 20,
    paddingBottom: 4,
  },
});
