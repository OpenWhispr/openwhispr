import { Tabs, useSegments } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { palette } from './ui';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { useState } from 'react';
export default function AndroidTabs() {
  const { t, i18n } = useTranslation();
  const { width, fontScale } = useWindowDimensions();
  const layoutKey = `${width}:${fontScale}:${i18n.resolvedLanguage ?? i18n.language}`;
  const [labels, setLabels] = useState<{ key: string; heights: Record<string, number> }>({
    key: layoutKey,
    heights: {},
  });
  const labelHeight = Math.max(
    30 * fontScale,
    ...Object.values(labels.key === layoutKey ? labels.heights : {}),
  );
  const insets = useSafeAreaInsets();
  const segments = useSegments() as string[];
  const detail =
    ((segments.includes('(notes)') || segments.includes('(chat)')) && segments.at(-1) === '[id]') ||
    (segments.includes('(notes)') &&
      (segments.at(-1) === 'meeting-record' || segments.at(-1) === 'import-audio'));
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.blue,
        tabBarInactiveTintColor: palette.muted,
        tabBarLabelPosition: 'below-icon',
        tabBarStyle: {
          backgroundColor: palette.background,
          borderTopColor: palette.line,
          display: detail ? 'none' : 'flex',
          height: Math.max(64, 40 + labelHeight) + insets.bottom,
        },
        tabBarLabel: ({ color, children }) => (
          <Text
            key={`${layoutKey}:${children}`}
            style={{
              fontSize: 12,
              lineHeight: 15,
              color,
              textAlign: 'center',
              width: '100%',
              flexShrink: 0,
            }}
            onLayout={({ nativeEvent }) => {
              const height = Math.ceil(nativeEvent.layout.height);
              setLabels((previous) => {
                const heights = previous.key === layoutKey ? previous.heights : {};
                if (heights[children] === height) return previous;
                return { key: layoutKey, heights: { ...heights, [children]: height } };
              });
            }}
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
        name="(chat)"
        options={{
          title: t('chat'),
          tabBarIcon: ({ color }) => (
            <SystemIcon
              name="bubble.left.and.bubble.right"
              mdName="MessagesSquare"
              size={23}
              color={color}
            />
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
    </Tabs>
  );
}
