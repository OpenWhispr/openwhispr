import '../global.css';
import { useEffect, useRef, useState } from 'react';
import { AppState, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack, router, useSegments } from 'expo-router';
import { ThemeProvider, DarkTheme, DefaultTheme } from '@react-navigation/native';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { startRetiredPromptSweep } from '@/store/useCustomPromptsStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { useUsageStore } from '@/store/useUsageStore';
import { resolveResumeAction } from '@/lib/appResume';
import { consumeRecoveryDeepLink } from '@/store/useKeyboardRecoveryStore';
import AuthScreen from '@/screens/AuthScreen';
import { OnboardingFlow } from '@/screens/onboarding/OnboardingFlow';
import { AnimatedSplash } from '@/components/features/AnimatedSplash';
import { useKeyboardHandoff } from '@/hooks/useKeyboardHandoff';
import { useRevenueCatIdentity } from '@/hooks/useRevenueCatIdentity';
import { useAnonymousOnboardingSession } from '@/hooks/useAnonymousOnboardingSession';
import { useGuestPrivateMode } from '@/hooks/useGuestPrivateMode';
import { runMigrations } from '@/db/migrate';
import { initSentry, Sentry } from '@/lib/sentry';
import { initAppsFlyer, refreshAppsFlyerTrackingAuthorization } from '@/lib/appsflyer';
import { initSyncTriggers } from '@/sync/syncEngine';
import { PermissionAlertMount } from '@/components/ui/PermissionAlert';
import { startKeyboardToneSync } from '@/lib/keyboardToneSync';
import { startKeyboardAgentSync } from '@/lib/keyboardAgentSync';
import { startKeyboardFullAccessProbe } from '@/lib/keyboardFullAccessProbe';
import { OpenWhisprSuperwallProvider } from '@/components/superwall/OpenWhisprSuperwallProvider';

initSentry();
initAppsFlyer();
runMigrations();

SplashScreen.preventAutoHideAsync().catch(() => {});

function RootLayout() {
  useKeyboardHandoff();
  useRevenueCatIdentity();
  useAnonymousOnboardingSession();
  useGuestPrivateMode();

  const [fontsLoaded] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
  });

  const colorScheme = useColorScheme();
  const initialize = useAuthStore((state) => state.initialize);
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const user = useAuthStore((state) => state.user);
  const isGuest = useAuthStore((state) => state.isGuest);
  const loadConfig = useConfigStore((state) => state.loadConfig);
  const hydrateOnboarding = useOnboardingStore((state) => state.hydrate);
  const onboardingHydrated = useOnboardingStore((state) => state.hydrated);
  const onboardingFinished = useOnboardingStore((state) => state.finished);
  const [showSplash, setShowSplash] = useState(true);

  // The splash covers cold-start work (JS init, migrations, fonts, auth). Dismiss
  // it the moment a real screen can render rather than on a fixed timer — the same
  // gate renderInner uses to stop returning null.
  const appReady = isInitialized && onboardingHydrated && fontsLoaded;

  // Live snapshot of the active route so the once-registered AppState listener and
  // the post-auth effect can tell when Home is already on top. Segments include
  // group names, so Home reads as ['(tabs)', '(record)'].
  const segments = useSegments() as string[];
  const alreadyOnHomeRef = useRef(false);
  alreadyOnHomeRef.current = segments[0] === '(tabs)' && segments[1] === '(record)';

  useEffect(() => {
    initialize();
    loadConfig();
    hydrateOnboarding();
    startRetiredPromptSweep();
  }, [initialize, loadConfig, hydrateOnboarding]);

  useEffect(() => {
    let started = false;
    let stopTone: (() => void) | undefined;
    let stopAgent: (() => void) | undefined;
    let stopFullAccessProbe: (() => void) | undefined;
    // Waits for config to hydrate so the probe's Sentry events respect the
    // user's Usage Analytics preference rather than the pre-hydration default.
    const startIfHydrated = (state: { config: unknown; isLoading: boolean }): void => {
      if (started) return;
      if (state.config !== null && !state.isLoading) {
        started = true;
        stopTone = startKeyboardToneSync();
        stopAgent = startKeyboardAgentSync();
        stopFullAccessProbe = startKeyboardFullAccessProbe();
      }
    };

    startIfHydrated(useConfigStore.getState());
    const unsubscribe = useConfigStore.subscribe(startIfHydrated);
    return () => {
      unsubscribe();
      stopTone?.();
      stopAgent?.();
      stopFullAccessProbe?.();
    };
  }, []);

  useEffect(() => {
    initSyncTriggers();
  }, []);

  // After an interactive sign-in (AuthScreen was shown, then auth completed),
  // land on home instead of restoring the route that was active before — e.g. the
  // Account screen the user signed in from. Cold launches and finishing onboarding
  // are anchored to home by app/index.tsx; this guard covers only the in-memory
  // remount after AuthScreen, which that "/" anchor can't reach. Skipped during
  // onboarding: the Stack isn't mounted there, and the brief signed-out window
  // before the anonymous session lands would otherwise look like a sign-in.
  const showedAuthRef = useRef(false);
  useEffect(() => {
    if (!isInitialized || !onboardingFinished) return;
    if (!user && !isGuest) {
      showedAuthRef.current = true;
    } else if (showedAuthRef.current) {
      showedAuthRef.current = false;
      // A Full Access recovery deep link that arrived while AuthScreen was up had
      // nowhere to land — AuthScreen renders *instead of* the navigator, so
      // expo-router never saw it. Send them there now rather than to Home.
      if (consumeRecoveryDeepLink()) {
        router.replace('/keyboard-full-access');
      } else if (!alreadyOnHomeRef.current) {
        router.replace('/(tabs)/(record)');
      }
    }
  }, [isInitialized, onboardingFinished, user, isGuest]);

  // Returning to a still-in-memory app (background→foreground) should land on
  // Home, not wherever it was suspended (e.g. the Account screen). Cold launches
  // go through app/index.tsx; warm resume never re-resolves "/", so it needs this
  // explicit reset. Tracking an actual 'background' first ignores transient
  // 'inactive' flickers (control center, notifications). `resolveResumeAction`
  // owns the guard list — flows that drive their own navigation (keyboard
  // handoff, calendar auth, Stripe link-out) opt out of the reset there.
  useEffect(() => {
    let backgrounded = false;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgrounded = true;
        return;
      }
      if (state === 'active') {
        // ATT can change in iOS Settings while the app is backgrounded. Reapply
        // that system decision before allowing any further attribution events.
        refreshAppsFlyerTrackingAuthorization().catch((error: unknown): void => {
          Sentry.captureException(error);
        });
      }
      if (state === 'active' && backgrounded) {
        backgrounded = false;
        const { resetToHome, refreshUsage } = resolveResumeAction(alreadyOnHomeRef.current);
        if (refreshUsage) {
          const usageStore = useUsageStore.getState();
          usageStore.endBillingSession();
          usageStore.load(true);
        }
        if (resetToHome) router.replace('/(tabs)/(record)');
      }
    });
    return () => sub.remove();
  }, []);

  const renderInner = () => {
    if (!appReady) return null;
    // Onboarding runs before any auth gate: it ends with its own paywall and
    // account step, so asking for an account up front would defeat the point.
    // Once onboarding is done, an explicit sign-out still lands on AuthScreen.
    if (!onboardingFinished) return <OnboardingFlow />;
    if (!user && !isGuest) return <AuthScreen />;
    return (
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          {/* Home is re-entered via router.replace on warm resume / post-auth; suppress
              the default slide so reopening to Home doesn't animate as if navigating. */}
          <Stack.Screen name="index" options={{ animation: 'none' }} />
          <Stack.Screen name="(tabs)" options={{ animation: 'none' }} />
          <Stack.Screen
            name="(account)"
            options={{ animation: 'slide_from_right', gestureEnabled: true }}
          />
          <Stack.Screen
            name="auth"
            options={{
              presentation: 'modal',
              animation: 'slide_from_bottom',
              gestureEnabled: true,
            }}
          />
          {/* A self-contained recovery task with its own Close, not a drill-down —
              same modal shape as auth. Declared rather than left to the navigator's
              defaults so the presentation is ours and cannot drift. */}
          <Stack.Screen
            name="keyboard-full-access"
            options={{
              presentation: 'modal',
              animation: 'slide_from_bottom',
              gestureEnabled: true,
            }}
          />
        </Stack>
      </ThemeProvider>
    );
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <OpenWhisprSuperwallProvider>
        <SafeAreaProvider>{renderInner()}</SafeAreaProvider>
        <PermissionAlertMount />
        {showSplash && <AnimatedSplash appReady={appReady} onFinish={() => setShowSplash(false)} />}
      </OpenWhisprSuperwallProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);
