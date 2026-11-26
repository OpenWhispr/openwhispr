import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, PermissionsAndroid, Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AuthScreen from '@/screens/AuthScreen.android';
import { handleAuthBack } from './auth/backPress';
import { needsEmailVerification } from './auth/emailVerification';
import { useAuthStore } from '@/android/store/useAuthStore';
import { useConfigStore } from '@/android/store/useConfigStore';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { AndroidDictation } from '../../modules/android-dictation/src';
import {
  clearProgress,
  nextStep,
  previousStep,
  saveProgress,
  savedMode,
  savedReturning,
  savedStep,
  type OnboardingMode,
  type OnboardingStep,
} from './onboarding/flow';
import { HowItWorksScreen, PitchScreen, SplashScreen } from './onboarding/IntroScreens';
import { PracticeScreen } from './onboarding/PracticeScreen';
import { PracticeMenuScreen } from './onboarding/PracticeMenuScreen';
import { LanguagesScreen } from './onboarding/LanguagesScreen';
import { AppsScreen } from './onboarding/AppsScreen';
import {
  AccessibilityScreen,
  BatteryScreen,
  NotificationsScreen,
  OverlayScreen,
  readStatus,
} from './onboarding/PermissionScreens';
import { ModeScreen, ReadyScreen } from './onboarding/EndScreens';
import { DeviceReadyScreen, DeviceSetupScreen } from './onboarding/DeviceSetupScreens';
import { applyCloudConfig } from './onboarding/setup';
import { useOnboardingT } from './onboarding/strings';
import { useOnboardingColors } from './onboarding/kit';
import { useNavigationBarCanvas } from './navigationBar';
import { finishedOnboardingOnAndroid } from './onboarding/accountOnboarding';

export { PlanContent as ProContent } from './PlanContent';

const BEFORE_SESSION: OnboardingStep[] = ['splash', 'signin'];

export function Onboarding({ onFinish }: { onFinish: () => void }) {
  const t = useOnboardingT();
  const [step, setStep] = useState<OnboardingStep>(savedStep);
  const [mode, setMode] = useState<OnboardingMode>(savedMode);
  // An account that finished onboarding on Android before skips the tour (F2).
  const [returning, setReturning] = useState(savedReturning);
  const [finishing, setFinishing] = useState(false);
  const user = useAuthStore((state) => state.user);
  const { register } = useSuperwallGate();
  const stepRef = useRef(step);
  stepRef.current = step;

  const go = useCallback(
    (next: OnboardingStep, nextMode: OnboardingMode = mode, nextReturning = returning) => {
      saveProgress(next, nextMode, nextReturning);
      setMode(nextMode);
      setReturning(nextReturning);
      setStep(next);
    },
    [mode, returning],
  );
  const advance = useCallback(() => {
    const next = nextStep(stepRef.current, mode, returning);
    if (next) go(next);
  }, [go, mode, returning]);
  // Signed in with a real account: the tour, or Languages for an account that already finished
  // onboarding on Android. The server is asked once, for at most 3 s; no answer is the tour.
  const asking = useRef(false);
  const startAfterSignIn = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;
    try {
      const finished = await finishedOnboardingOnAndroid();
      go(finished ? 'languages' : 'pitch', mode, finished);
    } finally {
      asking.current = false;
    }
  }, [go, mode]);
  const back = useCallback(() => {
    const previous = previousStep(stepRef.current, mode, returning);
    // Someone already signed in has nothing to do on the sign-in screen.
    if (previous === 'signin' && user && !user.isAnonymous && !needsEmailVerification(user))
      go('splash');
    else if (previous) go(previous);
  }, [go, mode, returning, user]);

  // The system back gesture walks back through the steps, as the on-screen back button does.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stepRef.current === 'splash') return false;
      if (stepRef.current === 'signin' && handleAuthBack()) return true;
      back();
      return true;
    });
    return () => subscription.remove();
  }, [back]);

  // A real sign-in on the sign-in screen moves straight on.
  useEffect(() => {
    // An email account verifies first, on the sign-in screen (6.1, decision 12).
    if (step === 'signin' && user && !user.isAnonymous && !needsEmailVerification(user))
      void startAfterSignIn();
  }, [startAfterSignIn, step, user]);

  // Practice runs on Cloud for free before anyone signs up, as on iOS: someone who skipped
  // sign-in gets an anonymous session that a later sign-up links to.
  useEffect(() => {
    if (BEFORE_SESSION.includes(step) || user) return;
    const ensure = () => void useAuthStore.getState().ensureAnonymousSession();
    ensure();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') ensure();
    });
    return () => subscription.remove();
  }, [step, user]);

  const enableBubble = useCallback(
    async (askNotifications: boolean) => {
      if (askNotifications && Number(Platform.Version) >= 33)
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(
          () => undefined,
        );
      const status = readStatus();
      if (!status.overlay || !status.accessibility) return;
      if (!status.microphone) {
        const mic = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ).catch(() => undefined);
        if (mic !== PermissionsAndroid.RESULTS.GRANTED) return;
      }
      try {
        AndroidDictation?.setEnabled(
          true,
          useConfigStore.getState().config?.androidBubbleSize ?? 64,
        );
      } catch (error) {
        Alert.alert('', t('bubbleCouldNotStart', { message: (error as Error).message }));
      }
    },
    [t],
  );

  const finish = useCallback(() => {
    if (finishing) return;
    setFinishing(true);
    clearProgress();
    onFinish();
  }, [finishing, onFinish]);

  // Choosing Cloud opens the Pro offer; paying or skipping both land on You're ready.
  const [offering, setOffering] = useState(false);
  const chooseCloud = useCallback(async () => {
    if (offering) return;
    setOffering(true);
    try {
      await applyCloudConfig();
      await register({ placement: SUPERWALL_PLACEMENTS.onboardingPaywall }).catch(() => false);
    } finally {
      setOffering(false);
      go('ready', 'cloud');
    }
  }, [go, offering, register]);

  // The page's own canvas under the system bar on every step but the blue ones (splash, sign in),
  // which keep theirs. One element for all steps, so stepping never hands the bar back in between.
  return (
    <>
      {BEFORE_SESSION.includes(step) ? null : <OnboardingBars />}
      {page()}
    </>
  );

  function page() {
    switch (step) {
      case 'splash':
        return (
          <SplashScreen
            onStart={() => {
              if (user && !user.isAnonymous && !needsEmailVerification(user))
                void startAfterSignIn();
              else go('signin');
            }}
          />
        );
      case 'signin':
        return (
          <>
            <StatusBar style="light" />
            <AuthScreen
              variant="onboarding"
              onClose={() => go('splash')}
              onGuestContinue={() => go('pitch', mode, false)}
            />
          </>
        );
      case 'pitch':
        return <PitchScreen onBack={back} onNext={advance} />;
      case 'how':
        return <HowItWorksScreen onBack={back} onNext={advance} />;
      case 'practiceDictate':
        return <PracticeScreen onBack={back} onNext={advance} />;
      case 'practiceAssistant':
        return (
          <PracticeMenuScreen key="assistant" kind="assistant" onBack={back} onNext={advance} />
        );
      case 'practiceEdit':
        return <PracticeMenuScreen key="edit" kind="edit" onBack={back} onNext={advance} />;
      case 'languages':
        return (
          <LanguagesScreen
            onBack={back}
            onNext={advance}
            // The tour it skipped is one tap away; from there it carries on as for anyone new.
            onSeeHowItWorks={returning ? () => go('how', mode, false) : undefined}
          />
        );
      case 'apps':
        return <AppsScreen onBack={back} onNext={advance} />;
      case 'overlay':
        return <OverlayScreen onBack={back} onNext={advance} />;
      case 'accessibility':
        return <AccessibilityScreen onBack={back} onNext={advance} />;
      case 'battery':
        return <BatteryScreen onBack={back} onNext={advance} />;
      case 'notifications':
        return (
          <NotificationsScreen
            onBack={back}
            onAllow={() => void enableBubble(true).finally(advance)}
            onSkip={() => void enableBubble(false).finally(advance)}
          />
        );
      case 'mode':
        return (
          <ModeScreen
            mode={mode}
            onBack={back}
            busy={offering}
            onChoose={(chosen) => {
              if (chosen === 'cloud') void chooseCloud();
              else go('privateSetup', 'private');
            }}
          />
        );
      case 'privateSetup':
        return (
          <DeviceSetupScreen
            onBack={back}
            onReady={advance}
            onUseCloud={() => void chooseCloud()}
          />
        );
      case 'privateReady':
        return <DeviceReadyScreen onNext={advance} />;
      case 'ready':
        return <ReadyScreen onDone={finish} onDevice={mode === 'private'} />;
    }
  }
}

function OnboardingBars() {
  useNavigationBarCanvas(useOnboardingColors().canvas);
  return null;
}
