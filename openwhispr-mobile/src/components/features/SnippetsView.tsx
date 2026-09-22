import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { SwipeableCard } from '@/components/ui/SwipeableCard';
import { SearchField } from '@/components/ui/SearchField';
import { Fab, FAB_BOTTOM_PADDING } from '@/components/ui/Fab';
import { AddSnippetSheet } from '@/components/features/AddSnippetSheet';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import type { Snippet } from '@/lib/snippets';
import { safeHaptics } from '@/lib/utils';
import { iosColor } from '@/config/colors';

function SnippetRow({
  snippet,
  onEdit,
  onDelete,
}: {
  snippet: Snippet;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <SwipeableCard onDelete={onDelete} inset>
      <Pressable
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel={`Edit snippet ${snippet.trigger}`}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        className="bg-secondarySystemGroupedBackground px-4 py-3.5"
      >
        <View className="flex-row items-center gap-2">
          <Text className="shrink-0 text-[15px] font-semibold text-label" numberOfLines={1}>
            {snippet.trigger}
          </Text>
          <SystemIcon name="arrow.right" mdName="ArrowRight" size={12} color="tertiaryLabel" />
          <Text className="min-w-0 flex-1 text-[15px] text-secondaryLabel" numberOfLines={1}>
            {snippet.replacement}
          </Text>
        </View>
      </Pressable>
    </SwipeableCard>
  );
}

function RowDivider() {
  return <View style={styles.divider} />;
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <View className="flex-1 items-center px-8 pt-12">
      <View
        style={{ borderCurve: 'continuous' }}
        className="mb-4 h-14 w-14 items-center justify-center rounded-2xl bg-quaternarySystemFill"
      >
        <SystemIcon name="text.append" mdName="Replace" size={24} color="secondaryLabel" />
      </View>
      <Text className="mb-2 text-[17px] font-semibold text-label">Snippets</Text>
      <Text className="mb-6 text-center text-[14px] leading-5 text-secondaryLabel">
        Turn a short spoken trigger into longer text. Say “signoff” and it expands to your full
        sign-off.
      </Text>
      <Pressable
        onPress={onAdd}
        style={({ pressed }) => ({ borderCurve: 'continuous', opacity: pressed ? 0.85 : 1 })}
        className="flex-row items-center gap-2 rounded-xl bg-link px-4 py-2.5"
      >
        <SystemIcon name="plus" mdName="Plus" size={15} color="#fff" />
        <Text className="text-[15px] font-semibold text-white">Add your first snippet</Text>
      </Pressable>
    </View>
  );
}

export function SnippetsView() {
  const entries = useSnippetsStore((s) => s.entries);
  const addSnippet = useSnippetsStore((s) => s.addSnippet);
  const updateSnippet = useSnippetsStore((s) => s.updateSnippet);
  const removeSnippet = useSnippetsStore((s) => s.removeSnippet);

  const [query, setQuery] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Snippet | null>(null);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter(
      (e) => e.trigger.toLowerCase().includes(term) || e.replacement.toLowerCase().includes(term),
    );
  }, [entries, query]);

  // Lowercased triggers in use, excluding the one being edited — for the sheet's
  // duplicate check.
  const existingTriggers = useMemo(() => {
    const editingTrigger = editing?.trigger.toLowerCase();
    return entries.map((e) => e.trigger.toLowerCase()).filter((t) => t !== editingTrigger);
  }, [entries, editing]);

  const isEmpty = entries.length === 0;
  const hasNoResults = !isEmpty && filtered.length === 0;

  const openCreate = () => {
    setEditing(null);
    setSheetOpen(true);
  };

  const openEdit = (snippet: Snippet) => {
    setEditing(snippet);
    setSheetOpen(true);
  };

  const handleDelete = (trigger: string) => {
    safeHaptics('warning');
    removeSnippet(trigger);
  };

  const handleSubmit = (trigger: string, replacement: string) => {
    if (editing) {
      updateSnippet(editing.trigger, { trigger, replacement });
    } else {
      addSnippet(trigger, replacement);
    }
  };

  return (
    <View className="flex-1">
      {isEmpty ? (
        <EmptyState onAdd={openCreate} />
      ) : (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{ paddingBottom: FAB_BOTTOM_PADDING }}
          showsVerticalScrollIndicator={false}
        >
          <View className="mx-4 mb-3 mt-3 flex-row">
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder="Search snippets"
              accessibilityLabel="Search snippets"
            />
          </View>

          {hasNoResults ? (
            <View className="items-center px-8 pt-12">
              <Text className="text-[14px] text-tertiaryLabel">
                {`No snippets match "${query.trim()}".`}
              </Text>
            </View>
          ) : (
            <View
              className="mx-4 mb-2 bg-secondarySystemGroupedBackground"
              style={styles.cardShadow}
            >
              <View
                className="overflow-hidden rounded-[14px] border border-separator"
                style={styles.cardInner}
              >
                {filtered.map((snippet, i) => (
                  <View key={snippet.trigger}>
                    {i > 0 && <RowDivider />}
                    <SnippetRow
                      snippet={snippet}
                      onEdit={() => openEdit(snippet)}
                      onDelete={() => handleDelete(snippet.trigger)}
                    />
                  </View>
                ))}
              </View>
            </View>
          )}
        </ScrollView>
      )}

      <Fab icon="plus" mdIcon="Plus" onPress={openCreate} accessibilityLabel="Add snippet" />

      <AddSnippetSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        initial={editing}
        existingTriggers={existingTriggers}
        onSubmit={handleSubmit}
        onDelete={editing ? () => removeSnippet(editing.trigger) : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
    backgroundColor: iosColor('separator'),
  },
  cardShadow: {
    borderRadius: 14,
    borderCurve: 'continuous',
    boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.10)',
  },
  cardInner: {
    borderCurve: 'continuous',
  },
});
