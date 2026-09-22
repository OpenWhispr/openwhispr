import { useEffect, useMemo, useState } from 'react';
import { View, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { TabScreenHeader } from '@/components/ui/TabScreenHeader';
import { SwipeableCard } from '@/components/ui/SwipeableCard';
import { SearchField } from '@/components/ui/SearchField';
import { Fab, FAB_BOTTOM_PADDING } from '@/components/ui/Fab';
import { AddWordsSheet } from '@/components/features/AddWordsSheet';
import { SnippetsView } from '@/components/features/SnippetsView';
import { SyncStatusLabel } from '@/components/notes/SyncStatusLabel';
import { useDictionaryStore, type DictionaryEntry } from '@/store/useDictionaryStore';
import { safeHaptics, formatRelativeTime } from '@/lib/utils';
import { iosColor } from '@/config/colors';

type Filter = 'all' | 'manual' | 'learned';
type Mode = 'words' | 'snippets';

const PURPLE = iosColor('systemPurple');
const LINK = iosColor('link');
const RECENT_LIMIT = 5;

function sourceLabel(entry: DictionaryEntry): string {
  const name = entry.source === 'manual' ? 'Manual' : 'Learned';
  if (!entry.addedAt) return name;
  return `${name} · ${formatRelativeTime(entry.addedAt, 'long')}`;
}

function alphabetize(entries: DictionaryEntry[]): { title: string; data: DictionaryEntry[] }[] {
  const sorted = [...entries].sort((a, b) =>
    a.word.localeCompare(b.word, undefined, { sensitivity: 'base' }),
  );
  const groups = new Map<string, DictionaryEntry[]>();
  for (const e of sorted) {
    const first = e.word[0]?.toUpperCase() ?? '#';
    const key = /[A-Z]/.test(first) ? first : '#';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  return Array.from(groups.entries()).map(([title, data]) => ({ title, data }));
}

function DictionaryRow({ entry, onDelete }: { entry: DictionaryEntry; onDelete: () => void }) {
  const dotColor = entry.source === 'manual' ? LINK : PURPLE;
  return (
    <SwipeableCard onDelete={onDelete} inset>
      <View className="flex-row items-center gap-3 bg-secondarySystemGroupedBackground px-4 py-2.5">
        <View style={{ backgroundColor: dotColor }} className="h-1.5 w-1.5 shrink-0 rounded-full" />
        <View className="min-w-0 flex-1">
          <Text className="text-[15px] text-label" numberOfLines={1}>
            {entry.word}
          </Text>
          <Text className="text-[12px] text-tertiaryLabel" numberOfLines={1}>
            {sourceLabel(entry)}
          </Text>
        </View>
      </View>
    </SwipeableCard>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View className="flex-row items-baseline justify-between px-8 pb-1.5 pt-3">
      <Text className="text-[11px] font-semibold uppercase tracking-wider text-secondaryLabel">
        {title}
      </Text>
      <Text style={{ fontVariant: ['tabular-nums'] }} className="text-[11px] text-tertiaryLabel">
        {count}
      </Text>
    </View>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <View className="mx-4 mb-2 bg-secondarySystemGroupedBackground" style={styles.cardShadow}>
      <View
        className="overflow-hidden rounded-[14px] border border-separator"
        style={styles.cardInner}
      >
        {children}
      </View>
    </View>
  );
}

function FilterChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count?: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        borderCurve: 'continuous',
        opacity: pressed ? 0.7 : 1,
      })}
      className={`flex-row items-center rounded-md px-3.5 py-2 ${
        active ? 'bg-brand' : 'bg-tertiarySystemFill'
      }`}
    >
      <Text className={`text-[14px] font-medium ${active ? 'text-white' : 'text-secondaryLabel'}`}>
        {label}
      </Text>
      {count !== undefined && (
        <Text
          style={{ fontVariant: ['tabular-nums'] }}
          className={`ml-1.5 text-[14px] font-semibold ${
            active ? 'text-white opacity-70' : 'text-tertiaryLabel'
          }`}
        >
          {count}
        </Text>
      )}
    </Pressable>
  );
}

function RowDivider() {
  return <View style={styles.divider} />;
}

function EntryList({
  entries,
  onDelete,
}: {
  entries: DictionaryEntry[];
  onDelete: (word: string) => void;
}) {
  return (
    <>
      {entries.map((entry, i) => (
        <View key={entry.word}>
          {i > 0 && <RowDivider />}
          <DictionaryRow entry={entry} onDelete={() => onDelete(entry.word)} />
        </View>
      ))}
    </>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <View className="flex-1 items-center px-8 pt-12">
      <View
        style={{ borderCurve: 'continuous' }}
        className="mb-4 h-14 w-14 items-center justify-center rounded-2xl bg-quaternarySystemFill"
      >
        <SystemIcon
          name="text.book.closed.fill"
          mdName="BookOpen"
          size={24}
          color="secondaryLabel"
        />
      </View>
      <Text className="mb-2 text-[17px] font-semibold text-label">Custom Dictionary</Text>
      <Text className="mb-6 text-center text-[14px] leading-5 text-secondaryLabel">
        Add words, names, or terms the transcription model should recognize.
      </Text>
      <Pressable
        onPress={onAdd}
        style={({ pressed }) => ({
          borderCurve: 'continuous',
          opacity: pressed ? 0.85 : 1,
        })}
        className="flex-row items-center gap-2 rounded-xl bg-link px-4 py-2.5"
      >
        <SystemIcon name="plus" mdName="Plus" size={15} color="#fff" />
        <Text className="text-[15px] font-semibold text-white">Add your first word</Text>
      </Pressable>
    </View>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const segments: { key: Mode; label: string }[] = [
    { key: 'words', label: 'Words' },
    { key: 'snippets', label: 'Snippets' },
  ];
  return (
    <View
      style={{ borderCurve: 'continuous' }}
      className="mx-4 mb-1 mt-3 flex-row rounded-[10px] bg-tertiarySystemFill p-0.5"
    >
      {segments.map((segment) => {
        const active = mode === segment.key;
        return (
          <Pressable
            key={segment.key}
            onPress={() => onChange(segment.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => ({ borderCurve: 'continuous', opacity: pressed ? 0.8 : 1 })}
            className={`flex-1 items-center rounded-lg py-1.5 ${
              active ? 'bg-secondarySystemGroupedBackground' : ''
            }`}
          >
            <Text
              className={`text-[14px] font-medium ${active ? 'text-label' : 'text-secondaryLabel'}`}
            >
              {segment.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function DictionaryScreen() {
  const entries = useDictionaryStore((s) => s.entries);
  const isLoaded = useDictionaryStore((s) => s.isLoaded);
  const load = useDictionaryStore((s) => s.load);
  const addWords = useDictionaryStore((s) => s.addWords);
  const removeWord = useDictionaryStore((s) => s.removeWord);
  const [mode, setMode] = useState<Mode>('words');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (!isLoaded) load();
  }, [isLoaded, load]);

  const counts = useMemo(() => {
    let manual = 0;
    let learned = 0;
    for (const e of entries) {
      if (e.source === 'manual') manual++;
      else learned++;
    }
    return { all: entries.length, manual, learned };
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const term = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter === 'manual' && e.source !== 'manual') return false;
      if (filter === 'learned' && e.source !== 'learned') return false;
      if (term && !e.word.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [entries, filter, query]);

  const recentEntries = useMemo(() => {
    if (query || filter !== 'all') return [];
    return [...filteredEntries]
      .filter((e) => e.addedAt !== null)
      .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
      .slice(0, RECENT_LIMIT);
  }, [filteredEntries, query, filter]);

  const recentKeys = useMemo(
    () => new Set(recentEntries.map((e) => e.word.toLowerCase())),
    [recentEntries],
  );
  const remainingEntries = useMemo(
    () => filteredEntries.filter((e) => !recentKeys.has(e.word.toLowerCase())),
    [filteredEntries, recentKeys],
  );
  const alphabetical = useMemo(() => alphabetize(remainingEntries), [remainingEntries]);

  const isEmpty = isLoaded && entries.length === 0;
  const hasNoResults = isLoaded && !isEmpty && filteredEntries.length === 0;

  const handleDelete = (word: string) => {
    safeHaptics('warning');
    removeWord(word);
  };

  return (
    <View className="flex-1 bg-systemBackground">
      <TabScreenHeader title="Dictionary" />

      <ModeToggle mode={mode} onChange={setMode} />

      {mode === 'snippets' ? (
        <SnippetsView />
      ) : (
        <>
          {isEmpty ? (
            <EmptyState onAdd={() => setSheetOpen(true)} />
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
                  placeholder="Search dictionary"
                  accessibilityLabel="Search dictionary"
                />
              </View>

              <View className="mx-4">
                <SyncStatusLabel />
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
                className="mb-1"
              >
                <FilterChip
                  label="All"
                  count={counts.all}
                  active={filter === 'all'}
                  onPress={() => setFilter('all')}
                />
                <FilterChip
                  label="Manual"
                  count={counts.manual}
                  active={filter === 'manual'}
                  onPress={() => setFilter('manual')}
                />
                <FilterChip
                  label="Learned"
                  count={counts.learned}
                  active={filter === 'learned'}
                  onPress={() => setFilter('learned')}
                />
              </ScrollView>

              {hasNoResults ? (
                <View className="items-center px-8 pt-12">
                  <Text className="text-[14px] text-tertiaryLabel">
                    {query ? `No words match "${query.trim()}".` : 'No words in this filter.'}
                  </Text>
                </View>
              ) : query ? (
                <View className="mt-2">
                  <SectionCard>
                    <EntryList entries={filteredEntries} onDelete={handleDelete} />
                  </SectionCard>
                </View>
              ) : (
                <>
                  {recentEntries.length > 0 && (
                    <>
                      <SectionHeader title="Recently Added" count={recentEntries.length} />
                      <SectionCard>
                        <EntryList entries={recentEntries} onDelete={handleDelete} />
                      </SectionCard>
                    </>
                  )}
                  {alphabetical.map((section) => (
                    <View key={section.title}>
                      <SectionHeader title={section.title} count={section.data.length} />
                      <SectionCard>
                        <EntryList entries={section.data} onDelete={handleDelete} />
                      </SectionCard>
                    </View>
                  ))}
                </>
              )}
            </ScrollView>
          )}

          <Fab
            icon="plus"
            mdIcon="Plus"
            onPress={() => setSheetOpen(true)}
            accessibilityLabel="Add words"
          />

          <AddWordsSheet
            visible={sheetOpen}
            onClose={() => setSheetOpen(false)}
            onSubmit={addWords}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 31,
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
