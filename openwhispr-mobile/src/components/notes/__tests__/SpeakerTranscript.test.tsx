import { Platform } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import type { Speaker } from '@/data/types';
import type { TranscriptBlock } from '@/lib/diarization/transcriptDisplay';
import { SpeakerTranscript } from '../SpeakerTranscript';
import { SpeakerRenameSheet } from '../SpeakerRenameSheet';
import { SpeakerMergeSheet } from '../SpeakerMergeSheet';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 54, right: 0, bottom: 24, left: 0 }),
}));

const speaker = (overrides: Partial<Speaker>): Speaker =>
  ({
    id: 1,
    noteId: 7,
    speakerLabel: 'SPEAKER_00',
    displayName: null,
    profileId: null,
    color: null,
    sortOrder: 0,
    speakerStatus: 'provisional',
    speakerLocked: 0,
    speakerLockSource: null,
    clientId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Speaker;

const block = (overrides: Partial<TranscriptBlock>): TranscriptBlock => ({
  id: 'segment-1',
  speakerId: 10,
  speakerLabel: 'SPEAKER_00',
  speakerName: 'Alice',
  speakerColor: '#007AFF',
  speakerStatus: null,
  startMs: 3_000,
  endMs: 4_000,
  timestamp: '0:03',
  text: 'Hello there.',
  segmentIds: [1],
  ...overrides,
});

describe('SpeakerTranscript', () => {
  it('renders fixture transcript with display names and timestamps', () => {
    const { getByText } = render(
      <SpeakerTranscript
        blocks={[
          block({}),
          block({ id: 'segment-2', speakerName: 'Bob', timestamp: '0:08', text: 'Hi.' }),
        ]}
      />,
    );

    expect(getByText('Alice')).toBeTruthy();
    expect(getByText('0:03')).toBeTruthy();
    expect(getByText('Hello there.')).toBeTruthy();
    expect(getByText('Bob')).toBeTruthy();
    expect(getByText('0:08')).toBeTruthy();
  });

  it('calls onSpeakerPress when tapping a speaker', () => {
    const onSpeakerPress = jest.fn();
    const transcriptBlock = block({});
    const { getByLabelText } = render(
      <SpeakerTranscript blocks={[transcriptBlock]} onSpeakerPress={onSpeakerPress} />,
    );

    fireEvent.press(getByLabelText('Edit Alice'));

    expect(onSpeakerPress).toHaveBeenCalledWith(transcriptBlock);
  });

  it('renders suggested speakers with a tentative marker', () => {
    const { getByText } = render(
      <SpeakerTranscript blocks={[block({ speakerName: 'Alice?', speakerStatus: 'suggested' })]} />,
    );

    expect(getByText('Alice?')).toBeTruthy();
  });
});

describe('SpeakerRenameSheet', () => {
  it('disables blank submit and submits trimmed names', () => {
    const onSave = jest.fn();
    const { getByTestId } = render(
      <SpeakerRenameSheet visible initialName="Alice" onCancel={() => {}} onSave={onSave} />,
    );

    fireEvent.changeText(getByTestId('speaker-rename-input'), '   ');
    fireEvent.press(getByTestId('speaker-rename-save'));
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId('speaker-rename-input'), ' Alicia ');
    fireEvent.press(getByTestId('speaker-rename-save'));
    expect(onSave).toHaveBeenCalledWith('Alicia');
  });

  it('submits attendee quick labels only when tapped', () => {
    const onSave = jest.fn();
    const { getByTestId } = render(
      <SpeakerRenameSheet
        visible
        initialName="Speaker 1"
        suggestions={[
          { label: 'Alice', email: 'alice@example.com' },
          { label: 'casey@example.com', email: 'casey@example.com' },
        ]}
        onCancel={() => {}}
        onSave={onSave}
      />,
    );

    expect(onSave).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('speaker-rename-suggestion-0'));

    expect(onSave).toHaveBeenCalledWith('Alice');
  });
});

describe('SpeakerMergeSheet', () => {
  it('excludes the source speaker and calls onMerge with source and target ids', () => {
    const onMerge = jest.fn();
    const source = speaker({ id: 10, speakerLabel: 'SPEAKER_00', displayName: 'Alice' });
    const target = speaker({
      id: 11,
      speakerLabel: 'SPEAKER_01',
      displayName: 'Bob',
      sortOrder: 1,
    });
    const { getByTestId, queryByTestId } = render(
      <SpeakerMergeSheet
        visible
        sourceSpeaker={source}
        speakers={[source, target]}
        onCancel={() => {}}
        onMerge={onMerge}
      />,
    );

    expect(queryByTestId('speaker-merge-target-10')).toBeNull();
    expect(getByTestId('speaker-merge-target-11')).toBeTruthy();

    fireEvent.press(getByTestId('speaker-merge-confirm'));

    expect(onMerge).toHaveBeenCalledWith(10, 11);
  });

  it('preselects a named target over an unnamed target', () => {
    const onMerge = jest.fn();
    const source = speaker({ id: 10, speakerLabel: 'SPEAKER_00', displayName: 'Fragment' });
    const unnamed = speaker({
      id: 11,
      speakerLabel: 'SPEAKER_01',
      displayName: null,
      sortOrder: 1,
    });
    const named = speaker({
      id: 12,
      speakerLabel: 'SPEAKER_02',
      displayName: 'Alice',
      sortOrder: 2,
    });
    const { getByTestId } = render(
      <SpeakerMergeSheet
        visible
        sourceSpeaker={source}
        speakers={[source, unnamed, named]}
        onCancel={() => {}}
        onMerge={onMerge}
      />,
    );

    fireEvent.press(getByTestId('speaker-merge-confirm'));

    expect(onMerge).toHaveBeenCalledWith(10, 12);
  });
});
let mockLanguage = 'en';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: mockLanguage },
    t: (key: string, options: Record<string, unknown> = {}) => {
      const resources =
        mockLanguage === 'ar'
          ? require('@/locales/ar/translation.json').android
          : require('@/locales/en/translation.json').android;
      const value =
        key.split('.').reduce((node: any, part: string) => node?.[part], resources) ??
        options.defaultValue ??
        key;
      return String(value).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));
    },
  }),
}));

it('preserves an edited speaker name across Android language changes and only saves explicit valid input', () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  try {
    const save = jest.fn();
    const cancel = jest.fn();
    const props = {
      visible: true,
      initialName: 'Alice',
      onSave: save,
      onCancel: cancel,
      suggestions: [{ label: 'Sam Lee' }],
    };
    const view = render(<SpeakerRenameSheet {...props} />);
    fireEvent.changeText(view.getByTestId('speaker-rename-input'), ' Literal Alicia ');
    mockLanguage = 'ar';
    view.rerender(<SpeakerRenameSheet {...props} />);
    expect(view.getByPlaceholderText('اسم المتحدث').props.value).toBe(' Literal Alicia ');
    fireEvent.press(view.getByLabelText('إلغاء إعادة التسمية'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    fireEvent.changeText(view.getByTestId('speaker-rename-input'), '   ');
    fireEvent.press(view.getByLabelText('حفظ اسم المتحدث'));
    expect(save).not.toHaveBeenCalled();
    fireEvent.changeText(view.getByTestId('speaker-rename-input'), ' Literal Alicia ');
    fireEvent.press(view.getByLabelText('حفظ اسم المتحدث'));
    expect(save).toHaveBeenLastCalledWith('Literal Alicia');
    fireEvent.press(view.getByLabelText('استخدام Sam Lee'));
    expect(save).toHaveBeenLastCalledWith('Sam Lee');
  } finally {
    Platform.OS = original;
    mockLanguage = 'en';
  }
});

it('preserves the chosen merge target through Android language changes and requires confirmation', () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  try {
    const source = speaker({ id: 10, displayName: 'Alice' });
    const speakers = [
      source,
      speaker({ id: 11, displayName: 'Bob', sortOrder: 1 }),
      speaker({ id: 12, displayName: 'Charlie', sortOrder: 2 }),
    ];
    const merge = jest.fn();
    const cancel = jest.fn();
    const props = {
      visible: true,
      sourceSpeaker: source,
      speakers,
      onMerge: merge,
      onCancel: cancel,
    };
    const view = render(<SpeakerMergeSheet {...props} />);
    fireEvent.press(view.getByTestId('speaker-merge-target-12'));
    mockLanguage = 'ar';
    view.rerender(<SpeakerMergeSheet {...props} />);
    expect(view.getByLabelText('دمج في Charlie').props.accessibilityState.selected).toBe(true);
    expect(view.queryByTestId('speaker-merge-target-10')).toBeNull();
    expect(view.getByText('سيبقى Charlie. سيُحذف Alice ويُنقل نصه إلى Charlie.')).toBeTruthy();
    fireEvent.press(view.getByLabelText('إلغاء الدمج'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(merge).not.toHaveBeenCalled();
    fireEvent.press(view.getByLabelText('تأكيد دمج المتحدث'));
    expect(merge).toHaveBeenCalledWith(10, 12);
    view.rerender(<SpeakerMergeSheet {...props} speakers={[source]} />);
    expect(view.getByText('لا يوجد متحدثون آخرون للدمج معهم.')).toBeTruthy();
    fireEvent.press(view.getByLabelText('تأكيد دمج المتحدث'));
    expect(merge).toHaveBeenCalledTimes(1);
  } finally {
    Platform.OS = original;
    mockLanguage = 'en';
  }
});

it('keeps a suggested speaker name literal and only confirms through the translated action', () => {
  const { VoiceprintSuggestionSheet } = require('../VoiceprintSuggestionSheet');
  const original = Platform.OS;
  Platform.OS = 'android';
  const confirm = jest.fn();
  const reject = jest.fn();
  const rename = jest.fn();
  const merge = jest.fn();
  const cancel = jest.fn();
  const props = {
    visible: true,
    speakerName: 'Literal Alice?',
    onConfirm: confirm,
    onReject: reject,
    onRename: rename,
    onMerge: merge,
    onCancel: cancel,
  };
  try {
    const view = render(<VoiceprintSuggestionSheet {...props} />);
    mockLanguage = 'ar';
    view.rerender(<VoiceprintSuggestionSheet {...props} />);
    expect(view.getByText('Literal Alice?')).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.press(view.getByText('تأكيد'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    fireEvent.press(view.getByText('رفض'));
    expect(reject).toHaveBeenCalledTimes(1);
    fireEvent.press(view.getByText('إعادة تسمية'));
    expect(rename).toHaveBeenCalledTimes(1);
    fireEvent.press(view.getByText('دمج'));
    expect(merge).toHaveBeenCalledTimes(1);
    fireEvent.press(view.getByText('إلغاء'));
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    Platform.OS = original;
    mockLanguage = 'en';
  }
});
