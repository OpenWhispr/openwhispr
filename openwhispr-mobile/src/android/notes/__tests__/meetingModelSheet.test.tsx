import { fireEvent, render } from '@testing-library/react-native';
import { MeetingModelRow } from '../meetingModelSheet';

const mockModels: { ready: Record<string, boolean>; progress: Record<string, number> } = {
  ready: {},
  progress: {},
};
jest.mock('../../settings/modelCatalog', () => ({
  MODEL_ROWS: [
    { id: 'parakeet-v3', kind: 'speech', name: 'Parakeet v3' },
    { id: 'meeting-speakers', kind: 'diarization', name: 'Meeting speakers' },
  ],
  meetingModelRows: () => [{ id: 'parakeet-v3', kind: 'speech', name: 'Parakeet v3' }],
  useModelsReady: () => ({ ...mockModels, checked: true, refresh: jest.fn() }),
}));
// The download row itself is Settings' ModelRow; here only which one shows, and its line.
jest.mock('../../settings/ModelRow', () => {
  const { Text } = require('react-native');
  return {
    ModelRow: ({ row, line }: { row: { name: string }; line?: string }) => (
      <Text>{[row.name, line].filter(Boolean).join(' / ')}</Text>
    ),
  };
});
jest.mock('../../settings/kit', () => ({
  Group: ({ children }: { children: React.ReactNode }) => children,
  useReduceMotion: () => false,
}));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => null }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), back: jest.fn() } }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

beforeEach(() => {
  mockModels.ready = {};
  mockModels.progress = {};
});

const row = (needsSpeech: boolean, needsSpeakers: boolean, onChoose = jest.fn()) =>
  render(
    <MeetingModelRow
      needsSpeech={needsSpeech}
      needsSpeakers={needsSpeakers}
      onChoose={onChoose}
      onLanded={jest.fn()}
    />,
  );

it('asks to choose a speech model first, and opens the list (S1)', () => {
  const onChoose = jest.fn();
  const view = row(true, true, onChoose);
  expect(view.getByText('On device needs one. It downloads once.')).toBeTruthy();
  expect(view.queryByText(/Meeting speakers/)).toBeNull();
  fireEvent.press(view.getByText('Choose a speech model'));
  expect(onChoose).toHaveBeenCalled();
});

it('shows the speech model downloading in place of the choice (S5)', () => {
  mockModels.progress = { 'parakeet-v3': 0.3 };
  const view = row(true, true);
  expect(view.getByText('Parakeet v3')).toBeTruthy();
  expect(view.queryByText('Choose a speech model')).toBeNull();
});

it('offers Meeting speakers once a speech model is on the phone (S9)', () => {
  const view = row(false, true);
  expect(view.getByText('Meeting speakers / Optional · names who spoke')).toBeTruthy();
});

it('shows nothing once both are on the phone (S7)', () => {
  expect(row(false, false).toJSON()).toBeNull();
});
