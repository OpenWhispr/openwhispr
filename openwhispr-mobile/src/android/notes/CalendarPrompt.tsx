import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useGoogleCalendarStore } from '@/android/shared/store/useGoogleCalendarStore';
import { useAuthStore } from '@/android/store/useAuthStore';
import { requiresRealAccount } from '@/android/lib/accountAccess';
import { useTheme } from '../ThemeProvider';
import { showToast } from '../settings/kit';
import {
  dismissCalendarPrompt,
  loadCalendarPromptDismissed,
  useCalendarPromptDismissed,
} from '../calendar/connect';
import { useConnectGoogle } from '../calendar/useConnectGoogle';
import { NoteTile, useNotesLook } from './look';
import { useNotesT } from './strings';

/**
 * Figma C1–C4: above Recent while no Google account is connected, until × hides it for good on
 * this phone. Connecting here or in Settings removes it (one store drives both).
 */
export function CalendarPrompt() {
  const t = useNotesT();
  const n = useNotesLook();
  const { glass, glassPressed } = useTheme();
  const accounts = useGoogleCalendarStore((state) => state.accounts);
  const user = useAuthStore((state) => state.user);
  const dismissed = useCalendarPromptDismissed((state) => state.dismissed);
  const { connecting, connect, cancel } = useConnectGoogle({ aboveTabBar: true });
  const load = useGoogleCalendarStore((state) => state.load);
  // Accounts read as none until the store has loaded once; the prompt waits for that.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    loadCalendarPromptDismissed();
    load()
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [load]);
  if (!loaded || dismissed !== false || accounts.length > 0 || !user || requiresRealAccount(user))
    return null;
  return (
    <View style={[n.edgeCard, { padding: 14, gap: 12 }]}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <NoteTile icon="Calendar" color={n.text} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={n.rowTitle}>{t(connecting ? 'connectingGoogle' : 'connectCalendar')}</Text>
          <Text style={n.rowSub}>
            {t(connecting ? 'connectingGoogleBody' : 'connectCalendarBody')}
          </Text>
        </View>
        {connecting ? null : (
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityLabel={t('hide')}
            hitSlop={10}
            onPress={() => {
              dismissCalendarPrompt();
              showToast(t('promptHidden'), 'neutral', undefined, { aboveTabBar: true });
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <SystemIcon name="xmark" mdName="X" size={16} color={n.text} />
          </Pressable>
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityState={{ disabled: connecting }}
          disabled={connecting}
          onPress={() => void connect()}
          style={({ pressed }) => [
            {
              flex: 1,
              minHeight: 44,
              borderRadius: 999,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: connecting ? 0.5 : 1,
            },
            glass,
            pressed && !connecting && glassPressed,
          ]}
        >
          <Text style={{ color: n.onGlass, fontSize: 15, lineHeight: 20, fontWeight: '500' }}>
            {t(connecting ? 'waitingGoogle' : 'connectGoogle')}
          </Text>
        </Pressable>
        {connecting ? (
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            onPress={cancel}
            hitSlop={8}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={{ color: n.accent, fontSize: 16, fontWeight: '500' }}>{t('cancel')}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
