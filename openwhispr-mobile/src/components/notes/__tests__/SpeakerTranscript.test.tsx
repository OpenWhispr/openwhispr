import { fireEvent, render } from '@testing-library/react-native';
import type { Speaker } from '@/data/types';
import type { TranscriptBlock } from '@/lib/diarization/transcriptDisplay';
import { SpeakerTranscript } from '../SpeakerTranscript';
import { SpeakerRenameSheet } from '../SpeakerRenameSheet';
import { SpeakerMergeSheet } from '../SpeakerMergeSheet';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));

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
