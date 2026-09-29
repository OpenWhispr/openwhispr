import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { Glass } from './Glass';
import { SystemIcon } from './SystemIcon';
import { AccountAvatarButton } from './AccountAvatarButton';
import { Text } from './Text';
import { BRAND } from '@/config/colors';
import { safeHaptics } from '@/lib/utils';
import { LiveActivity } from '../../../modules/live-activity/src';

const TRACK_OFF = '#E3E0DE';

type DictationModeControlProps = {
  onModeChange?: (enabled: boolean) => void;
};

/**
 * Cloud-toggle style power control for Dictation mode.
 */
function DictationPowerToggle({
  value,
  onToggle,
}: {
  value: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <Pressable
      onPress={() => {
        safeHaptics('selection');
        onToggle(!value);
      }}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel="Dictation mode"
      className="flex-row items-center rounded-full active:opacity-80"
      style={[styles.powerToggle, { backgroundColor: value ? BRAND : TRACK_OFF }]}
    >
      {value ? (
        <Text numberOfLines={1} className="ml-2 mr-1 text-xs font-bold text-white">
          On
        </Text>
      ) : null}
      <View style={styles.powerKnob}>
        <SystemIcon name="power" mdName="Power" size={15} color={value ? 'brand' : '#8E8E93'} />
      </View>
      {!value ? (
        <Text numberOfLines={1} className="ml-1 mr-2 text-xs font-bold text-secondaryLabel">
          Off
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Glass capsule pairing the Dictation-mode toggle with the account avatar.
 * Re-syncs on foreground because the Live Activity power button can flip the flag
 * natively while the app is backgrounded.
 */
export function DictationModeControl({ onModeChange }: DictationModeControlProps) {
  const [enabled, setEnabled] = useState(() => LiveActivity.isDictationModeEnabled());

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') setEnabled(LiveActivity.isDictationModeEnabled());
    });
    return () => sub.remove();
  }, []);

  const handleToggle = useCallback(
    (next: boolean) => {
      LiveActivity.setDictationMode(next);
      setEnabled(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  return (
    <Glass style={styles.pill}>
      <View style={styles.row}>
        <DictationPowerToggle value={enabled} onToggle={handleToggle} />
        <AccountAvatarButton />
      </View>
    </Glass>
  );
}

const styles = StyleSheet.create({
  pill: { borderRadius: 999, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  powerToggle: {
    height: 30,
    borderRadius: 15,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    boxShadow: '0px 1px 3px rgba(0,0,0,0.18)',
  },
  powerKnob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
