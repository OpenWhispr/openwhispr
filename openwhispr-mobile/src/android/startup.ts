// What Android's root layout ran at startup in Play build 60, when it loaded the iOS root layout
// for its side effects: the same imports, in the same order, then the same calls. The iOS
// screens, keyboard handoff and onboarding that layout also imported never ran on Android and are
// left out.
import './global.css';
import 'react-native-gesture-handler';
import 'react-native-safe-area-context';
import 'expo-router';
import '@react-navigation/native';
import * as SplashScreen from 'expo-splash-screen';
import 'expo-font';
import '@expo-google-fonts/space-grotesk';
import '@/android/store/useAuthStore';
import '@/android/store/useConfigStore';
import '@/android/shared/store/useCustomPromptsStore';
import '@/android/shared/store/useOnboardingStore';
import '@/android/store/useUsageStore';
import '@/screens/AuthScreen';
import '@/android/shared/hooks/useRevenueCatIdentity';
import { runMigrations } from '@/db/migrate';
import { initSentry } from '@/android/lib/sentry';
import { initAppsFlyer } from '@/android/lib/appsflyer';
import '@/android/sync/syncEngine';
import '@/android/lib/productEvents';
import { initDictationMilestone } from '@/android/lib/dictationMilestone';
import '@/android/lib/authClient';
import '@/android/shared/components/ui/PermissionAlert';
import '@/android/shared/lib/keyboardAgentSync';
import '@/android/shared/components/superwall/OpenWhisprSuperwallProvider';
import '@/services/providers/ProviderCredentials';

initSentry();
initAppsFlyer();
initDictationMilestone();
runMigrations();

SplashScreen.preventAutoHideAsync().catch(() => {});
