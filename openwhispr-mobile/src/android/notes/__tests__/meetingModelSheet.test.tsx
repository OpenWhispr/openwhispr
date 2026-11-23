import { act, fireEvent, render } from '@testing-library/react-native';
import { MeetingModelRow } from '../meetingModelSheet';

const mockModels: { ready: Record<string, boolean>; progress: Record<string, number> } = {
  ready: {},
  progress: {},
};
jest.mock('../../settings/modelCatalog', () => ({
  meetingModelRows: () => [{ id: 'parakeet-v3', kind: 'speech', name: 'Parakeet v3' }],
  useModelsReady: () => ({ ...mockModels, checked: true, refresh: jest.fn() }),
}));
// The download row itself is Settings' ModelRow; here only which one shows, and its line.
let mockSettle: ((ok: boolean) => void) | undefined;
jest.mock('../../settings/ModelRow', () => {
  const { Text } = require('react-native');
  return {
    ModelRow: ({
      row,
      line,
      onSettled,
    }: {
      row: { name: string };
      line?: string;
      onSettled?: (ok: boolean) => void;
    }) => {
      mockSettle = onSettled;
      return <Text>{[row.name, line].filter(Boolean).join(' / ')}</Text>;
    },
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

const row = (needsModel: boolean, onChoose = jest.fn()) =>
  render(<MeetingModelRow needsModel={needsModel} onChoose={onChoose} onLanded={jest.fn()} />);

it('asks to choose a meeting model first, and opens the list (S1)', () => {
  const onChoose = jest.fn();
  const view = row(true, onChoose);
  expect(view.getByText('On device needs one. It downloads once.')).toBeTruthy();
  fireEvent.press(view.getByText('Choose a meeting model'));
  expect(onChoose).toHaveBeenCalled();
});

it('shows the meeting model downloading in place of the choice (S5)', () => {
  mockModels.progress = { 'parakeet-v3': 0.3 };
  const view = row(true);
  expect(view.getByText('Parakeet v3')).toBeTruthy();
  expect(view.queryByText('Choose a meeting model')).toBeNull();
});

it('keeps the model on the sheet while its files are checked, then folds it away (S6)', () => {
  jest.useFakeTimers();
  const onLanded = jest.fn();
  mockModels.progress = { 'parakeet-v3': 0.99 };
  const view = render(<MeetingModelRow needsModel onChoose={jest.fn()} onLanded={onLanded} />);
  mockModels.progress = {};
  view.rerender(<MeetingModelRow needsModel onChoose={jest.fn()} onLanded={onLanded} />);
  expect(view.getByText('Parakeet v3')).toBeTruthy();
  act(() => mockSettle?.(true));
  expect(view.getByText('Parakeet v3')).toBeTruthy();
  act(() => jest.advanceTimersByTime(1000));
  expect(onLanded).toHaveBeenCalled();
  jest.useRealTimers();
});

it('shows nothing once a meeting model is on the phone, Meeting speakers or not (S7)', () => {
  expect(row(false).toJSON()).toBeNull();
});
