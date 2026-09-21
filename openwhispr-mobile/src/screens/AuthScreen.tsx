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
import { SpaceGrotesk } from '@/lib/fonts';
import { BRAND_GRADIENT } from '@/config/colors';
import { LinearGradient } from 'expo-linear-gradient';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';

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
const BUTTON_HEIGHT = 54;
const PILL_RADIUS = BUTTON_HEIGHT / 2;
// Deepest brand-gradient stop — page fallback + dark text/spinner on white surfaces.
const DEEP_BLUE = BRAND_GRADIENT[2];
const PLACEHOLDER_COLOR = 'rgba(255,255,255,0.55)';

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
      style={[styles.providerButton, isLoading && styles.disabled]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {loadingProvider === provider ? (
        <ActivityIndicator size="small" />
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
      <LinearGradient
        colors={BRAND_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
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
            <OpenWhisprMark size={32} color="#FFFFFF" />
            <Text style={styles.brandWord}>OpenWhispr</Text>
          </View>
          {onClose ? (
            <Pressable
              onPress={onClose}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel="Close sign in"
              hitSlop={8}
            >
              <SystemIcon name="xmark" mdName="X" size={16} color="#FFFFFF" />
            </Pressable>
          ) : null}

          {authMode ? (
            <View style={styles.authHeader}>
              <Pressable
                onPress={handleBack}
                style={styles.backButton}
                accessibilityRole="button"
                accessibilityLabel="Go back"
                hitSlop={8}
              >
                <SystemIcon name="chevron.left" mdName="ChevronLeft" size={22} color="#FFFFFF" />
              </Pressable>
              <Text style={styles.headline}>{headerTitle}</Text>
              {email.trim() ? <Text style={styles.headerSub}>{email.trim()}</Text> : null}
            </View>
          ) : (
            <Text style={styles.headline}>Privacy-first{'\n'}voice-to-text AI</Text>
          )}

          {/* Spacer pushes the action stack to the bottom (collapses with keyboard) */}
          <View style={styles.spacer} />

          <View>
            {!authMode && (
              <View style={styles.formGroup}>
                {isAppleAvailable ? (
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
                  style={[
                    styles.outlineButton,
                    (!email.trim() || isCheckingEmail) && styles.disabled,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Continue with email"
                >
                  {isCheckingEmail ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.outlineButtonText}>Continue</Text>
                  )}
                </Pressable>

                {!hideGuestContinue ? (
                  <Pressable
                    onPress={handleGuest}
                    disabled={isLoading}
                    style={styles.guestButton}
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
                  style={[styles.primaryButton, (!password || isLoading) && styles.disabled]}
                  accessibilityRole="button"
                  accessibilityLabel={authMode === 'signin' ? 'Sign in' : 'Create account'}
                >
                  {isLoading ? (
                    <ActivityIndicator color={DEEP_BLUE} />
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      {authMode === 'signin' ? 'Sign In' : 'Create Account'}
                    </Text>
                  )}
                </Pressable>

                <Pressable
                  onPress={handleToggleMode}
                  style={styles.toggleButton}
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
    backgroundColor: DEEP_BLUE,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 28,
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
    color: '#FFFFFF',
    letterSpacing: -0.4,
  },
  closeButton: {
    position: 'absolute',
    top: 18,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
  },

  headline: {
    fontSize: 40,
    lineHeight: 46,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -1.2,
    marginTop: 28,
  },
  authHeader: {
    marginTop: 28,
  },
  headerSub: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.7)',
    marginTop: 6,
  },
  backButton: {
    marginBottom: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },

  spacer: {
    flex: 1,
    minHeight: 32,
  },

  formGroup: {
    gap: 12,
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: BUTTON_HEIGHT,
    borderRadius: PILL_RADIUS,
    borderCurve: 'continuous',
    backgroundColor: '#FFFFFF',
    boxShadow: '0px 1px 3px rgba(0,0,0,0.12)',
  },
  providerButtonText: {
    fontSize: 16,
    color: '#000000',
    fontWeight: '600',
    letterSpacing: -0.3,
  },

  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 2,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  dividerText: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.65)',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  input: {
    height: BUTTON_HEIGHT,
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.4)',
    paddingHorizontal: 18,
    fontFamily: SpaceGrotesk.regular,
    fontSize: 16,
    color: '#FFFFFF',
    backgroundColor: 'rgba(255,255,255,0.25)',
  },

  outlineButton: {
    height: BUTTON_HEIGHT,
    borderRadius: PILL_RADIUS,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },

  guestButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  guestButtonText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '500',
  },

  primaryButton: {
    height: BUTTON_HEIGHT,
    borderRadius: PILL_RADIUS,
    borderCurve: 'continuous',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: DEEP_BLUE,
    letterSpacing: -0.2,
  },

  toggleButton: {
    paddingVertical: 6,
    alignItems: 'center',
  },
  toggleText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.85)',
    textAlign: 'center',
  },

  disabled: {
    opacity: 0.45,
  },

  errorBanner: {
    marginTop: 14,
    borderRadius: 14,
    borderCurve: 'continuous',
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,120,110,0.9)',
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  errorText: {
    fontSize: 13,
    color: '#FFE3E0',
    lineHeight: 18,
  },

  legal: {
    textAlign: 'center',
    fontSize: 12,
    color: 'rgba(255,255,255,0.7)',
    lineHeight: 16,
    marginTop: 18,
    paddingBottom: 4,
  },
});
