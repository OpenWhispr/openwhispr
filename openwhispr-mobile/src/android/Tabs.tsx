import { Tabs, useSegments } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { palette } from './ui';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
export default function AndroidTabs() {
  const { t } = useTranslation();
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const segments = useSegments() as string[];
  const detail =
    segments.includes('(notes)') &&
    (segments.at(-1) === '[id]' ||
      segments.at(-1) === 'meeting-record' ||
      segments.at(-1) === 'import-audio');
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.blue,
        tabBarInactiveTintColor: palette.muted,
        tabBarStyle: {
          backgroundColor: palette.background,
          borderTopColor: palette.line,
          display: detail ? 'none' : 'flex',
          height: Math.max(64, 40 + 30 * fontScale) + insets.bottom,
        },
        tabBarLabel: ({ color, children }) => (
          <Text
            style={{ fontSize: 12, lineHeight: 15, color, textAlign: 'center' }}
            numberOfLines={2}
          >
            {children}
          </Text>
        ),
      }}
    >
      <Tabs.Screen
        name="(record)"
        options={{
          title: t('home'),
          tabBarIcon: ({ color }) => (
            <SystemIcon name="house" mdName="House" size={23} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="(notes)"
        options={{
          title: t('notes'),
          tabBarIcon: ({ color }) => (
            <SystemIcon name="note.text" mdName="Notebook" size={23} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="(dictionary)"
        options={{
          title: t('dictionary'),
          tabBarIcon: ({ color }) => (
            <SystemIcon name="book" mdName="BookOpen" size={23} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="(style)"
        options={{
          title: t('style'),
          tabBarIcon: ({ color }) => (
            <SystemIcon name="sparkles" mdName="Sparkles" size={23} color={color} />
          ),
        }}
      />
      <Tabs.Screen name="(referral)" options={{ href: null }} />
    </Tabs>
  );
}
