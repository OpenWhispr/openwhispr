import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { AppFont } from '@/lib/fonts';
import { GlassButton, SecondaryButton, colors } from '../onboarding/kit';
import { BottomSheet } from '../settings/kit';
import { look } from '../settings/look';
import { markEndedSheetShown, useEndedSession } from '../auth/endedSession';
import { useLaunchT } from './strings';

// The Android splash (app.base.json): brand blue, with assets/splash-icon.png drawn 288 dp wide in
// the middle of the screen. The slow-open screen repeats it exactly, so the hand-off can't be seen.
const SPLASH_BLUE = colors.brandMid;
const SPLASH_ICON = require('../../../assets/splash-icon.png');
const SPLASH_ICON_DP = 288;
// The tile inside that image is 128 dp; the line sits 20 dp under it.
const LINE_OFFSET = 128 / 2 + 20;

/**
 * What shows under the native splash while the app gets ready, and in its place once loading
 * passes 1.5 s (a database upgrade after an update): the same screen, plus one quiet line (D3).
 */
export function LaunchSplash({ slow }: { slow: boolean }) {
  const t = useLaunchT();
  return (
    <View style={launch.screen} accessibilityLabel={slow ? t('opening') : undefined}>
      <StatusBar style="light" />
      <Image
        source={SPLASH_ICON}
        style={{ width: SPLASH_ICON_DP, height: SPLASH_ICON_DP }}
        accessibilityIgnoresInvertColors
      />
      {slow && (
        <View style={launch.lineRow} pointerEvents="none">
          <Text style={launch.line}>{t('opening')}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * Local data couldn't be opened (E4). Android never deletes anything here, so the screen says so;
 * the raw error goes behind Copy details for support.
 */
export function CouldNotOpen({ details, onRetry }: { details: string; onRetry: () => void }) {
  const t = useLaunchT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <SafeAreaView style={launch.errorScreen} edges={['top', 'bottom']}>
      <StatusBar style="dark" />
      <View style={launch.errorBody}>
        <View style={launch.errorTile}>
          <Text style={launch.errorMark}>!</Text>
        </View>
        <Text accessibilityRole="header" style={launch.errorTitle}>
          {t('couldNotOpen')}
        </Text>
        <Text style={launch.errorText}>{t('couldNotOpenBody')}</Text>
      </View>
      <View style={launch.errorActions}>
        <GlassButton label={t('tryAgain')} onPress={onRetry} />
        <SecondaryButton
          label={copied ? t('detailsCopied') : t('copyDetails')}
          onPress={() => {
            void Clipboard.setStringAsync(details).then(() => setCopied(true));
          }}
        />
      </View>
    </SafeAreaView>
  );
}

/**
 * The approved 2.4 sheet, once per ended session (F4). Sign in again opens 2.5, or 2.5b for a
 * Google or Microsoft account; Not now leaves the workspace as it is.
 */
export function SignedOutSheet() {
  const t = useLaunchT();
  const pending = useEndedSession((state) => state.sheetPending && state.user !== null);
  const close = () => markEndedSheetShown();
  return (
    <BottomSheet
      visible={pending}
      onClose={close}
      title={t('signedOutTitle')}
      body={t('signedOutBody')}
      above={
        <View style={launch.lockTile}>
          <SystemIcon name="lock.fill" mdName="Lock" size={18} color="#1A1A1A" />
        </View>
      }
    >
      <View style={{ gap: 4 }}>
        <GlassButton
          label={t('signInAgain')}
          onPress={() => {
            close();
            router.push('/auth');
          }}
        />
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          onPress={close}
          style={({ pressed }) => [launch.notNow, pressed && { opacity: 0.6 }]}
        >
          <Text style={launch.notNowLabel}>{t('notNow')}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const launch = StyleSheet.create({
  screen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: SPLASH_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lineRow: {
    position: 'absolute',
    left: 24,
    right: 24,
    top: '50%',
    marginTop: LINE_OFFSET,
    alignItems: 'center',
  },
  line: { color: 'rgba(255,255,255,0.78)', fontSize: 15, lineHeight: 20, textAlign: 'center' },
  errorScreen: { flex: 1, backgroundColor: look.canvas, paddingHorizontal: 16 },
  errorBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorTile: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  errorMark: { color: '#C2410C', fontSize: 26, lineHeight: 30, fontFamily: AppFont.bold },
  errorTitle: {
    color: colors.ink,
    fontSize: 22,
    lineHeight: 28,
    fontFamily: AppFont.medium,
    textAlign: 'center',
  },
  errorText: {
    color: colors.tertiary,
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  errorActions: { gap: 4, paddingBottom: 16 },
  lockTile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  },
  notNow: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  notNowLabel: { color: colors.ink, fontSize: 16, fontFamily: AppFont.medium },
});
