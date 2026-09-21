import { useEffect, useState, useCallback } from 'react';
import { View, TextInput, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useActionsStore } from '@/store/useActionsStore';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { SpaceGrotesk } from '@/lib/fonts';
import { safeHaptics } from '@/lib/utils';
import { confirmDestructive } from '@/lib/alerts';
import { iosColor } from '@/config/colors';

const PLACEHOLDER_COLOR = iosColor('tertiaryLabel');

export default function ActionManagerScreen() {
  const { actions, initialize, createAction, deleteAction } = useActionsStore();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    initialize();
  }, [initialize]);

  const handleSave = useCallback(() => {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName || !trimmedPrompt) return;

    safeHaptics('success');
    createAction(trimmedName, '', trimmedPrompt);
    setName('');
    setPrompt('');
  }, [name, prompt, createAction]);

  const handleDelete = useCallback(
    (id: number, actionName: string) => {
      confirmDestructive('Delete Action', `Delete "${actionName}"?`, () => {
        safeHaptics('medium');
        deleteAction(id);
      });
    },
    [deleteAction],
  );

  const canSave = name.trim().length > 0 && prompt.trim().length > 0;

  return (
    <ScrollView
      className="flex-1 bg-systemBackground"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      <Text className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-secondaryLabel">
        Create Action
      </Text>
      <View
        className="mb-8 gap-3 bg-secondarySystemBackground p-4"
        style={{ borderRadius: 12, borderCurve: 'continuous' }}
      >
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Action name"
          placeholderTextColor={PLACEHOLDER_COLOR}
          className="border-b border-separator/40 py-2 text-base text-label"
          style={{ fontFamily: SpaceGrotesk.regular }}
        />
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="Prompt instructions..."
          placeholderTextColor={PLACEHOLDER_COLOR}
          multiline
          textAlignVertical="top"
          className="min-h-[80px] py-2 text-[15px] text-label"
          style={{ fontFamily: SpaceGrotesk.regular }}
        />
        <Pressable
          onPress={handleSave}
          disabled={!canSave}
          className={'items-center rounded-[10px] py-3 ' + (canSave ? 'bg-brand' : 'bg-brand/30')}
          style={({ pressed }) => ({
            borderCurve: 'continuous',
            opacity: pressed ? 0.85 : 1,
            transform: [{ scale: pressed ? 0.98 : 1 }],
          })}
        >
          <Text className="text-[15px] font-semibold text-white">Save Action</Text>
        </Pressable>
      </View>

      <Text className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-secondaryLabel">
        Actions
      </Text>
      <View
        className="overflow-hidden bg-secondarySystemBackground"
        style={{ borderRadius: 12, borderCurve: 'continuous' }}
      >
        {actions.length === 0 ? (
          <View className="items-center p-5">
            <Text className="text-[15px] text-tertiaryLabel">No actions yet</Text>
          </View>
        ) : (
          actions.map((action, index) => {
            const isBuiltIn = action.isDefault === 1;
            return (
              <View
                key={action.id}
                className={
                  'flex-row items-center px-4 py-3.5 ' +
                  (index < actions.length - 1 ? 'border-b border-separator/30' : '')
                }
              >
                <View className="flex-1 gap-0.5">
                  <View className="flex-row items-center gap-1.5">
                    <Text className="text-base font-medium text-label" numberOfLines={1}>
                      {action.name}
                    </Text>
                    {isBuiltIn ? (
                      <View
                        className="bg-brand/10 px-1.5 py-px"
                        style={{ borderRadius: 6, borderCurve: 'continuous' }}
                      >
                        <Text className="text-[11px] font-medium text-brand">Built-in</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text className="text-[13px] text-secondaryLabel" numberOfLines={2}>
                    {action.prompt}
                  </Text>
                </View>
                {!isBuiltIn ? (
                  <Pressable
                    onPress={() => handleDelete(action.id, action.name)}
                    className="p-2"
                    style={({ pressed }) => ({
                      opacity: pressed ? 0.85 : 1,
                      transform: [{ scale: pressed ? 0.97 : 1 }],
                    })}
                  >
                    <SystemIcon name="trash" mdName="Trash2" size={18} color="systemRed" />
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}
