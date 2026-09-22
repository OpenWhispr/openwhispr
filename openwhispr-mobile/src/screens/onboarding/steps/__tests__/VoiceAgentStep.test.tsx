import { act, fireEvent, render } from '@testing-library/react-native';
import { VoiceAgentStep } from '../VoiceAgentStep';

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
const mockNext = jest.fn();
const mockBack = jest.fn();
jest.mock('@/hooks/useOnboardingStep', () => ({
  useOnboardingStep: () => ({
    goNext: mockNext,
    goBack: mockBack,
    progress: { current: 5, total: 9 },
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockNext.mockResolvedValue(undefined);
  mockBack.mockResolvedValue(undefined);
});

it('shows a voice-agent request and response without tone selection', () => {
  const screen = render(<VoiceAgentStep />);
  expect(screen.getByText('Meet your voice agent.')).toBeTruthy();
  expect(screen.getByText('Example request')).toBeTruthy();
  expect(screen.getByText('Example response')).toBeTruthy();
  expect(screen.queryAllByRole('radio')).toHaveLength(0);
});

it.each(['Continue', 'Skip'])('leaves the voice-agent demo using %s', async (action) => {
  const screen = render(<VoiceAgentStep />);
  await act(async () => {
    fireEvent.press(screen.getByText(action));
  });
  expect(mockNext).toHaveBeenCalledTimes(1);
});

it('can return to dictation practice', async () => {
  const screen = render(<VoiceAgentStep />);
  await act(async () => {
    fireEvent.press(screen.getByText('Back'));
  });
  expect(mockBack).toHaveBeenCalledTimes(1);
});
