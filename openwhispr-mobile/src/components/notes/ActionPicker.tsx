import { ActionSheetIOS, ActivityIndicator, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { Glass } from '@/components/ui/Glass';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/lib/utils';
import { BRAND } from '@/config/colors';
import type { Action } from '@/data';

interface ActionPickerProps {
  actions: Action[];
  onRunAction: (action: Action) => void;
  onManageActions: () => void;
  disabled?: boolean;
  processing?: boolean;
  /** Compact icon-only variant for nav-bar placement. */
  compact?: boolean;
}

export function ActionPicker({
  actions,
  onRunAction,
  onManageActions,
  disabled,
  processing,
  compact,
}: ActionPickerProps) {
  const firstAction = actions[0];
  const label = firstAction?.name ?? 'Enhance';

  const handlePress = () => {
    if (!firstAction || disabled || processing) return;
    safeHaptics('light');
    onRunAction(firstAction);
  };

  const handleChevron = () => {
    if (disabled || processing) return;
    safeHaptics('light');

    const actionNames = actions.map((a) => a.name);
    const options = [...actionNames, 'Manage Actions...', 'Cancel'];
    const cancelButtonIndex = options.length - 1;

    ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex }, (buttonIndex) => {
      if (buttonIndex === cancelButtonIndex) return;
      if (buttonIndex === options.length - 2) {
        onManageActions();
        return;
      }
      const action = actions[buttonIndex];
      if (action) onRunAction(action);
    });
  };

  if (compact) {
    return (
      <View className="flex-row items-center">
        <Pressable
          onPress={handlePress}
          disabled={disabled || processing || !firstAction}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={firstAction ? `Run ${label}` : 'Enhance'}
          className="px-1 py-1 active:opacity-50"
          style={{ opacity: disabled ? 0.4 : 1 }}
        >
          {processing ? (
            <ActivityIndicator size="small" color={BRAND} />
          ) : (
            <SystemIcon name="sparkles" mdName="Sparkles" size={22} color="brand" />
          )}
        </Pressable>
        <Pressable
          onPress={handleChevron}
          disabled={disabled || processing}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Pick action"
          className="pl-0.5 pr-1 py-1 active:opacity-50"
          style={{ opacity: disabled ? 0.4 : 1 }}
        >
          <SystemIcon name="chevron.down" mdName="ChevronDown" size={12} color="secondaryLabel" />
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-row items-center gap-px">
      <Glass.Interactive
        className="overflow-hidden"
        style={{
          borderTopLeftRadius: 12,
          borderBottomLeftRadius: 12,
          borderCurve: 'continuous',
        }}
      >
        <Pressable
          onPress={handlePress}
          disabled={disabled || processing || !firstAction}
          className="flex-row items-center gap-1.5 px-3 py-2 active:opacity-70"
          style={{ opacity: disabled ? 0.4 : 1 }}
        >
          {processing ? (
            <ActivityIndicator size="small" color={BRAND} />
          ) : (
            <SystemIcon name="sparkles" mdName="Sparkles" size={16} color="brand" />
          )}
          <Text className="text-[13px] font-medium text-label" numberOfLines={1}>
            {label}
          </Text>
        </Pressable>
      </Glass.Interactive>

      <Glass.Interactive
        className="overflow-hidden"
        style={{
          borderTopRightRadius: 12,
          borderBottomRightRadius: 12,
          borderCurve: 'continuous',
        }}
      >
        <Pressable
          onPress={handleChevron}
          disabled={disabled || processing}
          className="px-2 py-2 active:opacity-70"
          style={{ opacity: disabled ? 0.4 : 1 }}
        >
          <SystemIcon name="chevron.down" mdName="ChevronDown" size={12} color="secondaryLabel" />
        </Pressable>
      </Glass.Interactive>
    </View>
  );
}
