import { act, render, waitFor } from '@testing-library/react-native';
import DiarizationModelScreen from '../DiarizationModelScreen';

let mockDownloading = false;
let mockFinishDownload: () => void = () => {};
const mockDownload = jest.fn(() => new Promise<void>((resolve) => (mockFinishDownload = resolve)));
const mockState = {
  isDiarizerAvailable: jest.fn(async () => true),
  isDiarizerModelReady: jest.fn(async () => false),
  isDiarizerModelDownloading: jest.fn(() => mockDownloading),
  downloadDiarizerModel: mockDownload,
  deleteDiarizerModel: jest.fn(async () => undefined),
};

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/lib/alerts', () => ({ confirmDestructive: jest.fn() }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));

beforeEach(() => {
  jest.clearAllMocks();
  mockDownloading = false;
});

describe('DiarizationModelScreen', () => {
  it('offers the download when the model is missing', async () => {
    const { findByText, queryByText } = render(<DiarizationModelScreen />);
    expect(await findByText('Speaker model')).toBeTruthy();
    expect(queryByText('Downloading…')).toBeNull();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('shows a download another screen started, then the downloaded model', async () => {
    mockDownloading = true;
    const { findByText, getByText } = render(<DiarizationModelScreen />);

    expect(await findByText('Downloading…')).toBeTruthy();
    expect(mockDownload).toHaveBeenCalledTimes(1);

    await act(async () => mockFinishDownload());
    await waitFor(() => expect(getByText('Downloaded')).toBeTruthy());
  });
});
