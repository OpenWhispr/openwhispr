import { useRef } from 'react';
import type React from 'react';
import { Alert, Pressable, View } from 'react-native';
import { router, useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { TAB_BAR_CLEARANCE, isTabBarHidden } from '@/components/ui/tabBarClearance';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { formatClock, meetingBarState } from '@/lib/notes/meetingCapture';
import { Sentry } from '@/lib/sentry';
import { safeHaptics } from '@/lib/utils';
import { useAuthStore } from '@/store/useAuthStore';
import { useHandoffStore } from '@/store/useHandoffStore';
import { useMeetingSession } from './MeetingSessionProvider';

const MEETING_ROUTE = '/(tabs)/(notes)/meeting-record';

/** Distance from the screen bottom: above the keyboard when it is open, else clear of the tab bar or home indicator. */
export function meetingBarBottom(input: {
  tabBarVisible: boolean;
  insetBottom: number;
  keyboardHeight: number;
}): number {
  if (input.keyboardHeight > 0) return input.keyboardHeight + 12;
  return input.tabBarVisible ? TAB_BAR_CLEARANCE + 4 : input.insetBottom + 12;
}

/**
 * A capsule floating over every screen while a meeting is open, so the user can tell it is
 * recording, tap back into it, or end it. Hidden on the meeting screen itself, during the
 * keyboard handoff takeover, and when nobody is signed in.
 */
export function MeetingInProgressBar(): React.JSX.Element | null {
  const session = useMeetingSession();
  const segments = useSegments() as string[];
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const handoffActive = useHandoffStore((s) => s.isActive);
  const signedIn = useAuthStore((s) => s.user != null || s.isGuest);
  // A second tap while the stop is in flight would ask to end an already ending meeting.
  const stoppingRef = useRef(false);

  if (session.phase === 'idle' || !signedIn || handoffActive) return null;
  if (segments[1] === '(notes)' && segments[2] === 'meeting-record') return null;

  const state = meetingBarState({
    phase: session.phase,
    path: session.path,
    capturing: session.capturing,
    cloudStatus: session.cloud.status,
    captureStarted: session.cloud.liveSinceMs !== null,
  });

  const tabBarShown = segments[0] === '(tabs)' && !isTabBarHidden(segments, handoffActive);
  const bottom = meetingBarBottom({
    tabBarVisible: tabBarShown,
    insetBottom: insets.bottom,
    keyboardHeight,
  });

  const openMeeting = (): void => {
    safeHaptics('light');
    router.navigate(MEETING_ROUTE);
  };

  const confirmStop = (): void => {
    if (stoppingRef.current) return;
    safeHaptics('warning');
    Alert.alert('End meeting?', undefined, [
      { text: 'Keep recording', style: 'cancel' },
      {
        text: 'End meeting',
        style: 'destructive',
        onPress: () => {
          if (stoppingRef.current) return;
          stoppingRef.current = true;
          session
            .stop()
            .catch((error: unknown): void => {
              Sentry.captureException(error);
            })
            .finally(() => {
              stoppingRef.current = false;
            });
        },
      },
    ]);
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom,
        alignItems: 'center',
        zIndex: 9000,
      }}
    >
      <View
        className="flex-row items-center rounded-full border border-separator bg-secondarySystemGroupedBackground shadow-sm"
        style={{ borderCurve: 'continuous' }}
      >
        <Pressable
          onPress={openMeeting}
          accessibilityRole="button"
          accessibilityLabel={`Meeting in progress, ${state.label.toLowerCase()}. Open the meeting`}
          className="flex-row items-center gap-2 py-2.5 pl-4 pr-3"
        >
          <View
            testID="meeting-bar-dot"
            className={`h-2.5 w-2.5 rounded-full ${state.recordingAudio ? 'bg-systemRed' : 'bg-tertiaryLabel'}`}
          />
          <Text className="text-[12px] font-semibold tracking-wide text-secondaryLabel">
            {state.label}
          </Text>
          {state.showClock ? (
            <Text
              className="text-[15px] font-semibold text-label"
              style={{ fontVariant: ['tabular-nums'] }}
            >
              {formatClock(session.capturedSeconds)}
            </Text>
          ) : null}
        </Pressable>
        {state.showStop ? (
          <Pressable
            onPress={confirmStop}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="End meeting"
            className="py-2.5 pl-1 pr-4"
          >
            <SystemIcon name="stop.fill" mdName="Square" size={16} color="systemRed" />
          </Pressable>
        ) : (
          <View className="pr-1" />
        )}
      </View>
    </View>
  );
}
