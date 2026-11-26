// Forked unchanged in src/android/shared: one module for both paths in this test.
jest.mock('@/lib/diarization/transcriptDisplay', () =>
  jest.requireActual('@/android/shared/lib/diarization/transcriptDisplay'),
);
import React, { createRef, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';

const mockPrepare = jest.fn(async () => true);
jest.mock('../../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: () => mockPrepare(),
  fadeTheme: jest.fn(),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color }: { color: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID="glyph" accessibilityHint={color} />;
  },
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), canGoBack: () => false } }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaView: require('react-native').View,
}));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/android/shared/lib/utils', () => jest.requireMock('@/lib/utils'));
jest.mock('../../settings/kit', () => ({ useReduceMotion: () => true }));
jest.mock('../strings', () => ({
  useNotesT: () => (key: string) => key,
  notesT: (key: string) => key,
}));

import { ThemeProvider } from '../../ThemeProvider';
import { darkTheme, lightTheme } from '../../theme';
import { FormatBar, MetaChip, NoSummaryCard, SoftChip, TranscriptCard } from '../noteParts';
import { LiveMarkdown, NotesReadView } from '../liveMarkdown';
import { SummaryEditor, type SummaryEditorHandle } from '../SummaryEditor';
import { SegmentedControl } from '@/components/ui/SegmentedControl.android';
import type { TranscriptBlock } from '@/lib/diarization/transcriptDisplay';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
const noop = () => undefined;

const blocks = [
  {
    id: 'b1',
    speakerId: 1,
    speakerName: 'Sam',
    speakerLabel: 'Sam',
    speakerColor: '',
    speakerStatus: 'confirmed',
    timestamp: '0:04',
    text: 'Ship it',
  },
] as unknown as TranscriptBlock[];

/** The pieces of a note, as the editor stacks them. */
function NotePieces() {
  return (
    <View>
      <MetaChip testID="chip" icon="Calendar" label="Today" />
      <SegmentedControl
        value="notes"
        onChange={noop}
        options={[
          { value: 'enhanced', label: 'Summary', dot: true, testID: 'tab-enhanced' },
          { value: 'notes', label: 'Notes', testID: 'tab-notes' },
        ]}
      />
      <SoftChip testID="soft" label="Make shorter" />
      <NoSummaryCard body="body" templateName="Meeting" onWrite={noop} onTemplate={noop} />
      <TranscriptCard blocks={blocks} onSpeakerPress={noop} />
      <NotesReadView
        text={'# Plan\n- [x] shipped\n**bold**'}
        editable
        onEdit={noop}
        onToggle={noop}
      />
      <FormatBar onFormat={noop} onDone={noop} />
    </View>
  );
}

/** The colour a piece of text draws in: its own, else the nearest enclosing text's. */
function textColor(label: string) {
  let node: ReturnType<typeof screen.getByText> | null = screen.getByText(label);
  while (node) {
    const color = flat(node.props.style)?.color;
    if (color) return color;
    node = node.parent;
  }
  return undefined;
}

async function switchTo(scheme: 'light' | 'dark', rerender: () => void) {
  mockScheme.mockReturnValue(scheme);
  await act(async () => {
    rerender();
  });
}

describe('a note in both schemes', () => {
  beforeEach(() => mockScheme.mockReturnValue('light'));

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)('draws its pieces from the %s palette', async (scheme, k) => {
    mockScheme.mockReturnValue(scheme);
    render(
      <ThemeProvider>
        <NotePieces />
      </ThemeProvider>,
    );
    expect(flat(screen.getByTestId('chip').props.style).backgroundColor).toBe(k.surface);
    expect(textColor('Today')).toBe(k.ink);
    expect(textColor('Notes')).toBe(k.ink);
    expect(textColor('Summary')).toBe(k.secondary);
    expect(textColor('Make shorter')).toBe(k.ink);
    expect(textColor('noSummary')).toBe(k.ink);
    expect(textColor('Ship it')).toBe(k.ink);
    expect(textColor('Sam')).toBe(k.accent);
    expect(textColor('done')).toBe(k.accent);
    // A ticked checklist line is greyed.
    expect(textColor('shipped')).toBe(k.secondary);
    // The read view's body and its heading.
    expect(textColor('Plan')).toBe(k.ink);
    // The out-of-date dot is a status colour.
    const dot = screen
      .getByTestId('tab-enhanced')
      .findAll(
        (node: { props: { style?: unknown } }) =>
          flat(node.props.style)?.width === 6 && flat(node.props.style)?.height === 6,
      )[0];
    expect(flat(dot.props.style).backgroundColor).toBe(k.warning);
    // The brand glass keeps white on it in both schemes.
    expect(textColor('writeSummary')).toBe(k.onGlass);
  });

  it('colours the live Markdown marks and mentions from the theme', () => {
    mockScheme.mockReturnValue('dark');
    render(
      <ThemeProvider>
        <Text>
          <LiveMarkdown text="**bold** @sam" caret={0} />
        </Text>
      </ThemeProvider>,
    );
    const marks = screen.getAllByText('**');
    expect(flat(marks[0].props.style).color).toBe(darkTheme.tertiary);
  });

  it('repaints the summary editor in place: same field, same text, focus kept', async () => {
    const ref = createRef<SummaryEditorHandle>();
    let mounts = 0;
    function Counter() {
      useState(() => {
        mounts += 1;
        return 0;
      });
      return null;
    }
    const onFocusChange = jest.fn();
    const tree = () => (
      <ThemeProvider>
        <Counter />
        <SummaryEditor
          ref={ref}
          content=""
          editable
          onChange={noop}
          onEditingChange={noop}
          onFocusChange={onFocusChange}
        />
      </ThemeProvider>
    );
    const { rerender } = render(tree());
    const field = screen.getByTestId('enhanced-editor');
    fireEvent(field, 'focus');
    fireEvent.changeText(field, 'Draft in progress');
    expect(field.props.placeholderTextColor).toBe(lightTheme.tertiary);
    expect(field.props.cursorColor).toBe(lightTheme.accent);

    await switchTo('dark', () => rerender(tree()));

    const after = screen.getByTestId('enhanced-editor');
    expect(after).toBe(field);
    expect(mounts).toBe(1);
    expect(after.props.placeholderTextColor).toBe(darkTheme.tertiary);
    expect(after.props.selectionColor).toBe(darkTheme.selFill);
    expect(after.props.selectionHandleColor).toBe(darkTheme.accent);
    expect(after.props.cursorColor).toBe(darkTheme.accent);
    expect(flat(after.props.style).color).toBe(darkTheme.ink);
    // Still being edited: no blur reported, the draft is still in the field.
    expect(onFocusChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText('Draft in progress')).toBeTruthy();
  });

  it('keeps a typed TextInput across a switch', async () => {
    const input = createRef<TextInput>();
    function Field() {
      const [value, setValue] = useState('');
      return (
        <>
          <SegmentedControl value="a" onChange={noop} options={[{ value: 'a', label: 'A' }]} />
          <TextInput ref={input} testID="field" value={value} onChangeText={setValue} />
        </>
      );
    }
    const tree = () => (
      <ThemeProvider>
        <Field />
      </ThemeProvider>
    );
    const { rerender } = render(tree());
    const node = input.current;
    fireEvent.changeText(screen.getByTestId('field'), 'hello');
    await switchTo('dark', () => rerender(tree()));
    expect(input.current).toBe(node);
    expect(screen.getByTestId('field').props.value).toBe('hello');
    expect(textColor('A')).toBe(darkTheme.ink);
  });
});
