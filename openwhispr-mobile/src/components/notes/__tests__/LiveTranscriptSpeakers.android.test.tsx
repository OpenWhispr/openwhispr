import { render } from '@testing-library/react-native';
import { LiveTranscriptListView } from '../LiveTranscriptListView.android';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/config/colors', () => ({ BRAND: '#007AFF' }));

const line = (itemId: string, text: string): RealtimeUtterance => ({
  itemId,
  text,
  startMs: null,
  endMs: null,
});

it('names the speaker above a line wherever the speaker changes, numbered by who spoke first', () => {
  const view = render(
    <LiveTranscriptListView
      utterances={[
        line('a', 'Hi all.'),
        line('b', 'Agenda first.'),
        line('c', 'Sounds good.'),
        line('d', 'Later.'),
      ]}
      partialText=""
      speakerLabels={{ a: 'speaker_4', b: 'speaker_4', c: 'speaker_1' }}
      active
    />,
  );
  expect(view.getByTestId('live-speaker-a')).toHaveTextContent('Speaker 1');
  expect(view.queryByTestId('live-speaker-b')).toBeNull();
  expect(view.getByTestId('live-speaker-c')).toHaveTextContent('Speaker 2');
  // Not known yet: the line shows without a name.
  expect(view.queryByTestId('live-speaker-d')).toBeNull();
  expect(view.getByText('Later.')).toBeTruthy();
});

it('shows plain lines when no speakers are known', () => {
  const view = render(
    <LiveTranscriptListView utterances={[line('a', 'Hello.')]} partialText="" active />,
  );
  expect(view.queryByText(/Speaker/)).toBeNull();
});
