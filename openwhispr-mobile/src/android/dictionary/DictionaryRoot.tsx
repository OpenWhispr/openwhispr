import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useScrollToTop } from '@react-navigation/native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { SegmentedControl } from '@/components/ui/SegmentedControl.android';
import { AppFont } from '@/lib/fonts';
import { safeHaptics } from '@/lib/utils';
import { sharedWordKey } from '@/lib/sharedDictionaryHints';
import type { Snippet } from '@/lib/snippets';
import { useDictionaryStore, type DictionaryEntry } from '@/store/useDictionaryStore';
import { useSharedDictionaryStore } from '@/store/useSharedDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import { home, type } from '../home/kit';
import { useNavigationBarCanvas } from '../navigationBar';
import { tabColors } from '../tabBar';
import { useSettingsToast } from '../settings/kit';
import { edge, look } from '../settings/look';
import { Card, IconButton, NewButton, NotesHeader, SectionLabel, notesLook } from '../notes/look';
import { SwipeRow } from '../notes/rows';
import {
  addWordsByHand,
  consumeRestoredRow,
  deleteSnippetWithUndo,
  deleteWordWithUndo,
} from './actions';
import { DictionaryEmpty } from './Empty';
import { loadLearnedWords, learnedInfo, reviewQueue, useAccountLearned } from './learned';
import { ReviewStack } from './ReviewStack';
import { searchSnippets, searchWords, sortWords } from './search';
import { AddWordsSheet, EditWordSheet, SnippetSheet } from './sheets';
import { shortDate } from './time';
import { useDictionaryT, type DictionaryT } from './strings';

type Mode = 'words' | 'snippets';

function Tile({ learned }: { learned: boolean }) {
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: look.idleFill,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {learned ? (
        <SystemIcon name="sparkles" mdName="Sparkles" size={17} color={home.secondary} />
      ) : (
        <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '500', color: home.secondary }}>
          Aa
        </Text>
      )}
    </View>
  );
}

function wordLine(
  entry: DictionaryEntry,
  keptAt: number | null,
  t: DictionaryT,
  language: string,
): string {
  if (entry.source === 'manual')
    return entry.addedAt
      ? t('addedByYouOn', { date: shortDate(entry.addedAt, language) })
      : t('addedByYou');
  if (keptAt) return t('learnedKeptOn', { date: shortDate(keptAt, language) });
  return entry.addedAt
    ? t('learnedOn', { date: shortDate(entry.addedAt, language) })
    : t('learned');
}

/** A word in the list: tap to edit (C3), swipe left to delete with Undo (C4). */
function WordRow({ entry, onEdit }: { entry: DictionaryEntry; onEdit: () => void }) {
  const t = useDictionaryT();
  const { i18n } = useTranslation();
  const learned = useAccountLearned();
  const hiddenForYou = useSharedDictionaryStore(
    (s) => !!entry.sharedAt && s.hiddenOnlyKeys.has(sharedWordKey(entry.word)),
  );
  const info = learnedInfo(learned, entry.word);
  const line = wordLine(entry, info?.keptAt ?? null, t, i18n.language);
  const sub = hiddenForYou ? `${line} · ${t('hiddenForYou')}` : line;
  const restored = useRef(consumeRestoredRow(entry.word)).current;
  return (
    <SwipeRow onDelete={() => deleteWordWithUndo(entry)} restored={restored}>
      <Pressable
        cssInterop={false}
        accessibilityRole="button"
        accessibilityLabel={`${entry.word}, ${sub}`}
        onPress={onEdit}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          minHeight: 64,
          backgroundColor: pressed ? 'rgba(0,0,0,0.04)' : home.surface,
        })}
      >
        <Tile learned={entry.source === 'learned'} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={notesLook.rowTitle}>
            {entry.word}
          </Text>
          <Text numberOfLines={1} style={notesLook.rowSub}>
            {sub}
          </Text>
        </View>
      </Pressable>
    </SwipeRow>
  );
}

function SnippetRow({ snippet, onEdit }: { snippet: Snippet; onEdit: () => void }) {
  const restored = useRef(consumeRestoredRow(`snippet:${snippet.trigger}`)).current;
  return (
    <SwipeRow onDelete={() => deleteSnippetWithUndo(snippet)} restored={restored}>
      <Pressable
        cssInterop={false}
        accessibilityRole="button"
        accessibilityLabel={`${snippet.trigger}, ${snippet.replacement}`}
        onPress={onEdit}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          minHeight: 64,
          backgroundColor: pressed ? 'rgba(0,0,0,0.04)' : home.surface,
        })}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            backgroundColor: look.idleFill,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SystemIcon name="text.bubble" mdName="MessagesSquare" size={18} color={home.secondary} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={notesLook.rowTitle}>
            {snippet.trigger}
          </Text>
          <Text numberOfLines={1} style={notesLook.rowSub}>
            {snippet.replacement.replace(/\s+/g, ' ')}
          </Text>
        </View>
      </Pressable>
    </SwipeRow>
  );
}

/** Words that apply from a shared list; managed on desktop, so the row only says so. */
function TeamWordsRow({ moved }: { moved: string[] }) {
  const t = useDictionaryT();
  const summary = useSharedDictionaryStore((s) => s.summary);
  if (!summary || summary.count === 0) return null;
  const workspace = summary.workspaceName.trim() || t('yourWorkspace');
  const title =
    summary.count === 1
      ? t('teamWordsOne', { workspace })
      : t('teamWordsMany', { count: summary.count, workspace });
  const movedLine =
    moved.length === 0
      ? ''
      : moved.length === 1
        ? ` ${t('teamWordsMovedOne', { word: moved[0] })}`
        : ` ${t('teamWordsMovedMany', { count: moved.length })}`;
  return (
    <Card>
      <View
        accessible
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, minHeight: 64 }}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            backgroundColor: look.idleFill,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SystemIcon name="person.2" mdName="Users" size={18} color={home.secondary} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={notesLook.rowTitle}>{title}</Text>
          <Text style={notesLook.rowSub}>
            {t('teamWordsBody')}
            {movedLine}
          </Text>
        </View>
      </View>
    </Card>
  );
}

function SearchBar({
  value,
  onChange,
  onCancel,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  placeholder: string;
}) {
  const t = useDictionaryT();
  const input = useRef<TextInput>(null);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 47 }}>
      <View
        style={[
          edge,
          {
            flex: 1,
            minHeight: 48,
            borderRadius: 14,
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: 14,
            paddingRight: 6,
            gap: 8,
            borderColor: 'rgba(21,85,212,0.55)',
            borderWidth: 1.5,
          },
        ]}
      >
        <SystemIcon name="magnifyingglass" mdName="Search" size={18} color={home.secondary} />
        <TextInput
          ref={input}
          autoFocus
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={home.tertiary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={{
            flex: 1,
            fontSize: 17,
            color: home.text,
            fontFamily: AppFont.regular,
            paddingVertical: 8,
          }}
        />
        {value ? (
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityLabel={t('clear')}
            hitSlop={8}
            onPress={() => {
              onChange('');
              input.current?.focus();
            }}
            style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
          >
            <SystemIcon name="xmark" mdName="X" size={18} color={home.secondary} />
          </Pressable>
        ) : null}
      </View>
      <Pressable
        cssInterop={false}
        accessibilityRole="button"
        onPress={onCancel}
        hitSlop={8}
        style={({ pressed }) => ({
          minHeight: 44,
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ color: home.accent, fontSize: 16, lineHeight: 22, fontWeight: '500' }}>
          {t('cancel')}
        </Text>
      </Pressable>
    </View>
  );
}

/** C5's "Add “Synty”" row: adds exactly what was typed. */
function AddQueryRow({ query }: { query: string }) {
  const t = useDictionaryT();
  return (
    <Card>
      <Pressable
        cssInterop={false}
        accessibilityRole="button"
        onPress={() => {
          safeHaptics('success');
          addWordsByHand([query.trim()]);
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: 14,
          minHeight: 64,
          backgroundColor: pressed ? look.idleFill : home.surface,
        })}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            backgroundColor: look.selFill,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SystemIcon name="plus" mdName="Plus" size={18} color={home.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={[notesLook.rowTitle, { color: home.accent }]}>
            {t('addQuery', { query: query.trim() })}
          </Text>
          <Text style={notesLook.rowSub}>{t('toYourWords')}</Text>
        </View>
      </Pressable>
    </Card>
  );
}

/**
 * Android's Dictionary in OpenWhispr's design (Figma "C · Josh's picks"): C1 the words with
 * the learned-word review stack, C4 swipe to delete with Undo, C5 search, C6 the empty
 * states and C13 snippets. The sheets (C2, C3 and the snippet sheet) live in ./sheets.
 */
export default function DictionaryRoot() {
  const t = useDictionaryT();
  const scroll = useRef<ScrollView>(null);
  useScrollToTop(scroll);
  useNavigationBarCanvas(tabColors.bar);

  const allEntries = useDictionaryStore((s) => s.entries);
  const wordsLoaded = useDictionaryStore((s) => s.isLoaded);
  const loadWords = useDictionaryStore((s) => s.load);
  const snippets = useSnippetsStore((s) => s.entries);
  const snippetsLoaded = useSnippetsStore((s) => s.isLoaded);
  const loadSnippets = useSnippetsStore((s) => s.load);
  const sharedWordsLower = useSharedDictionaryStore((s) => s.sharedWordsLower);
  const learned = useAccountLearned();
  useEffect(() => {
    if (!wordsLoaded) void loadWords();
    if (!snippetsLoaded) void loadSnippets();
    void loadLearnedWords();
  }, [wordsLoaded, snippetsLoaded, loadWords, loadSnippets]);

  const [mode, setMode] = useState<Mode>('words');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [addVisible, setAddVisible] = useState(false);
  const [editing, setEditing] = useState<DictionaryEntry | null>(null);
  const [snippetSheet, setSnippetSheet] = useState<{ snippet: Snippet | null } | null>(null);
  // The Undo toast sits where the add button floats; it steps aside until the toast closes.
  const undoShowing = useSettingsToast((state) => state.action != null);
  // A plain toast ("Added 2 words") shows 2.4 s where the add button floats; the button steps
  // aside for it too, and comes back once it has gone.
  const toastId = useSettingsToast((state) => state.id);
  const [plainToast, setPlainToast] = useState(false);
  const firstToastId = useRef(toastId);
  useEffect(() => {
    if (toastId === firstToastId.current) return;
    setPlainToast(true);
    const timer = setTimeout(() => setPlainToast(false), 2600);
    return () => clearTimeout(timer);
  }, [toastId]);

  // A word moved into a shared list applies as a team word until its shared copy is gone, so
  // it leaves "your words" and the team row names it instead.
  const { entries, moved } = useMemo(() => {
    const kept: DictionaryEntry[] = [];
    const movedWords: string[] = [];
    for (const entry of allEntries) {
      if (entry.sharedAt && sharedWordsLower.has(sharedWordKey(entry.word)))
        movedWords.push(entry.word);
      else kept.push(entry);
    }
    return { entries: kept, moved: movedWords };
  }, [allEntries, sharedWordsLower]);

  const review = useMemo(() => reviewQueue(entries, learned), [entries, learned]);
  const reviewing = new Set(review.map((item) => item.word.toLowerCase()));
  const yours = useMemo(
    () => sortWords(entries.filter((entry) => !reviewing.has(entry.word.toLowerCase()))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, review],
  );

  const closeSearch = () => {
    setSearching(false);
    setQuery('');
  };
  useEffect(() => {
    if (!searching) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSearch();
      return true;
    });
    return () => sub.remove();
  }, [searching]);

  const onAdd = () => {
    if (mode === 'words') setAddVisible(true);
    else setSnippetSheet({ snippet: null });
  };

  const wordSearch = useMemo(() => searchWords(entries, query), [entries, query]);
  const snippetHits = useMemo(() => searchSnippets(snippets, query), [snippets, query]);

  const wordsEmpty = wordsLoaded && entries.length === 0 && moved.length === 0;
  const snippetsEmpty = snippetsLoaded && snippets.length === 0;
  const showEmpty = !searching && (mode === 'words' ? wordsEmpty : snippetsEmpty);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={{ flex: 1, backgroundColor: notesLook.canvas }}
    >
      <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 16 }}>
        {searching ? (
          <SearchBar
            value={query}
            onChange={setQuery}
            onCancel={closeSearch}
            placeholder={mode === 'words' ? t('searchWords') : t('searchSnippets')}
          />
        ) : (
          <>
            <NotesHeader
              title={t('dictionary')}
              right={
                showEmpty ? undefined : (
                  <IconButton
                    icon="Search"
                    label={t('search')}
                    onPress={() => setSearching(true)}
                  />
                )
              }
            />
            <SegmentedControl<Mode>
              value={mode}
              onChange={(next) => {
                safeHaptics('selection');
                setMode(next);
              }}
              options={[
                {
                  value: 'words',
                  label: t('words'),
                  count: wordsEmpty ? undefined : entries.length,
                },
                {
                  value: 'snippets',
                  label: t('snippets'),
                  count: snippetsEmpty ? undefined : snippets.length,
                },
              ]}
            />
          </>
        )}
      </View>
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ padding: 16, paddingBottom: 112, gap: 12, flexGrow: 1 }}
      >
        {showEmpty ? (
          <DictionaryEmpty variant={mode} onAdd={onAdd} />
        ) : searching ? (
          mode === 'words' ? (
            query.trim() ? (
              <>
                {!wordSearch.exact && (
                  <>
                    <SectionLabel label={t('noWordCalled', { query: query.trim() })} />
                    <AddQueryRow query={query} />
                  </>
                )}
                {(wordSearch.exact || wordSearch.matches.length > 0) && (
                  <>
                    <View style={{ height: 4 }} />
                    <SectionLabel label={wordSearch.exact ? t('matches') : t('closeMatches')} />
                    <Card>
                      {[...(wordSearch.exact ? [wordSearch.exact] : []), ...wordSearch.matches].map(
                        (entry) => (
                          <WordRow
                            key={entry.word}
                            entry={entry}
                            onEdit={() => setEditing(entry)}
                          />
                        ),
                      )}
                    </Card>
                  </>
                )}
              </>
            ) : null
          ) : snippetHits.length > 0 ? (
            <Card>
              {snippetHits.map((snippet) => (
                <SnippetRow
                  key={snippet.trigger}
                  snippet={snippet}
                  onEdit={() => setSnippetSheet({ snippet })}
                />
              ))}
            </Card>
          ) : query.trim() ? (
            <Text style={[type.footnote, { textAlign: 'center', paddingTop: 48 }]}>
              {t('noSnippetCalled', { query: query.trim() })}
            </Text>
          ) : null
        ) : mode === 'words' ? (
          <>
            {review.length > 0 && (
              <View style={{ marginBottom: 8 }}>
                <ReviewStack items={review} />
              </View>
            )}
            {yours.length > 0 && (
              <>
                <SectionLabel label={t('yourWords', { count: yours.length })} />
                <Card>
                  {yours.map((entry) => (
                    <WordRow key={entry.word} entry={entry} onEdit={() => setEditing(entry)} />
                  ))}
                </Card>
              </>
            )}
            <TeamWordsRow moved={moved} />
          </>
        ) : (
          <>
            <SectionLabel label={t('sayTheTrigger')} />
            <Card>
              {snippets.map((snippet) => (
                <SnippetRow
                  key={snippet.trigger}
                  snippet={snippet}
                  onEdit={() => setSnippetSheet({ snippet })}
                />
              ))}
            </Card>
          </>
        )}
      </ScrollView>
      {showEmpty || searching || undoShowing || plainToast ? null : (
        <NewButton
          onPress={onAdd}
          bottom={16}
          label={mode === 'words' ? t('addWord') : t('addSnippet')}
        />
      )}
      <AddWordsSheet visible={addVisible} onClose={() => setAddVisible(false)} />
      <EditWordSheet entry={editing} onClose={() => setEditing(null)} />
      <SnippetSheet
        visible={snippetSheet != null}
        snippet={snippetSheet?.snippet ?? null}
        onClose={() => setSnippetSheet(null)}
      />
    </SafeAreaView>
  );
}
