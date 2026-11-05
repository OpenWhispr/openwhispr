import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { VoiceEnrollmentRecorder } from '../VoiceEnrollmentRecorder';
import { useAudioRecording } from '@/hooks/useAudioRecording';
import {
  VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED,
  VOICE_ENROLLMENT_LOW_SNR,
  VOICE_ENROLLMENT_STORAGE_FAILED,
  VoiceEnrollmentError,
} from '@/services/diarization/VoiceprintService';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/data/local/notesRepository';
import { MicPermissionError, showMicPermissionAlert } from '@/lib/permissions';
import { Sentry } from '@/lib/sentry';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/features/WaveformVisualizer', () => ({ WaveformVisualizer: () => null }));
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: () => null,
  Circle: () => null,
}));
jest.mock('@/hooks/useAudioWaveform', () => ({
  useAudioWaveform: () => ({ currentAmplitude: 0, waveformData: [] }),
}));
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn(async () => undefined) }));
jest.mock('@/components/ui/Button', () => {
  const mockReact = require('react');
  const mockText = require('react-native').Text;
  return {
    Button: function MockButton(props: any) {
      return mockReact.createElement(
        mockText,
        {
          onPress: props.disabled ? undefined : props.onPress,
          testID: props.testID,
          accessibilityState: { disabled: !!props.disabled },
        },
        props.children,
      );
    },
  };
});
jest.mock('@/hooks/useAudioRecording', () => ({ useAudioRecording: jest.fn() }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/lib/permissions', () => ({
  ...jest.requireActual('@/lib/permissions'),
  showMicPermissionAlert: jest.fn(),
}));

const mockUseAudioRecording = useAudioRecording as jest.MockedFunction<typeof useAudioRecording>;
const startRecording = jest.fn(async () => undefined);
const stopRecordingRaw = jest.fn(async (): Promise<string | null> => 'file://sample.wav');
const cancelRecording = jest.fn();

const renderRecorder = (overrides: Partial<Parameters<typeof VoiceEnrollmentRecorder>[0]> = {}) => {
  const props = {
    isOwner: true,
    isModelReady: jest.fn(async () => true),
    isModelDownloading: jest.fn(() => false),
    downloadModel: jest.fn(async () => undefined),
    onSubmit: jest.fn(async () => undefined),
    onDone: jest.fn(),
    onCancel: jest.fn(),
    now: () => new Date('2026-09-27T09:00:00.000Z'),
    ...overrides,
  };
  return { props, ...render(<VoiceEnrollmentRecorder {...props} />) };
};

const recordFor = async (
  utils: ReturnType<typeof renderRecorder>,
  seconds: number,
): Promise<void> => {
  await waitFor(() => expect(utils.getByTestId('voice-enrollment-record')).toBeTruthy());
  await act(async () => {
    fireEvent.press(utils.getByTestId('voice-enrollment-record'));
  });
  await act(async () => {
    jest.advanceTimersByTime(seconds * 1000);
  });
};

// Mirrors the real hook: useAudioRecorder's releasing cleanup is declared before the
// recorder component's own effects, so on unmount it releases the native recorder first,
// and every property read after that throws NativeSharedObjectNotFoundException.
const mockReleasingRecorder = (waitForStop: () => Promise<void> = async () => undefined) => {
  let released = false;
  let recordingNow = false;
  const read = <T,>(value: T): T => {
    if (released) throw new Error('NativeSharedObjectNotFoundException');
    return value;
  };
  const audioRecorder = {
    get uri() {
      return read('file://partial.wav');
    },
    get isRecording() {
      return read(recordingNow);
    },
  } as unknown as ReturnType<typeof useAudioRecording>['audioRecorder'];
  const recording = {
    ...mockUseAudioRecording(),
    startRecording: jest.fn(async () => {
      recordingNow = true;
    }),
    cancelRecording: jest.fn(async () => {
      if (audioRecorder.isRecording) recordingNow = false;
    }),
    stopRecordingRaw: jest.fn(async () => {
      if (!audioRecorder.isRecording) return null;
      await waitForStop();
      recordingNow = false;
      return audioRecorder.uri ?? null;
    }),
    audioRecorder,
  };
  mockUseAudioRecording.mockImplementation(() => {
    require('react').useEffect(
      () => () => {
        released = true;
      },
      [],
    );
    return recording;
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockUseAudioRecording.mockReturnValue({
    isRecording: false,
    isProcessing: false,
    currentText: '',
    isSupported: true,
    startRecording,
    stopRecording: jest.fn(),
    stopRecordingRaw,
    cancelRecording,
    audioRecorder: { isRecording: true } as ReturnType<typeof useAudioRecording>['audioRecorder'],
  });
});
afterEach(() => jest.useRealTimers());

describe('VoiceEnrollmentRecorder', () => {
  it('asks before downloading the speaker model, and Not Now downloads nothing', async () => {
    const utils = renderRecorder({ isModelReady: jest.fn(async () => false) });
    await waitFor(() => expect(utils.getByText('Download the speaker model')).toBeTruthy());
    expect(utils.queryByTestId('voice-enrollment-record')).toBeNull();

    fireEvent.press(utils.getByTestId('voice-enrollment-not-now'));

    expect(utils.props.onCancel).toHaveBeenCalled();
    expect(utils.props.downloadModel).not.toHaveBeenCalled();
  });

  it('lets you read while the model downloads, then checks once it has finished', async () => {
    let finishDownload: () => void = () => {};
    const downloadModel = jest.fn(() => new Promise<void>((resolve) => (finishDownload = resolve)));
    const utils = renderRecorder({ isModelReady: jest.fn(async () => false), downloadModel });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-download')).toBeTruthy());
    fireEvent.press(utils.getByTestId('voice-enrollment-download'));
    expect(utils.getByTestId('voice-enrollment-downloading')).toBeTruthy();

    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });
    expect(utils.getByTestId('voice-enrollment-checking')).toBeTruthy();
    expect(utils.getByText(/waiting for the speaker model/i)).toBeTruthy();
    expect(utils.props.onSubmit).not.toHaveBeenCalled();

    await act(async () => finishDownload());
    await waitFor(() => expect(utils.props.onSubmit).toHaveBeenCalledTimes(1));
  });

  it('deletes a recording waiting on the download when you leave, and never submits it', async () => {
    let finishDownload: () => void = () => {};
    const downloadModel = jest.fn(() => new Promise<void>((resolve) => (finishDownload = resolve)));
    const utils = renderRecorder({ isModelReady: jest.fn(async () => false), downloadModel });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-download')).toBeTruthy());
    fireEvent.press(utils.getByTestId('voice-enrollment-download'));

    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });
    expect(utils.getByTestId('voice-enrollment-checking')).toBeTruthy();

    utils.unmount();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://sample.wav', { idempotent: true });

    await act(async () => finishDownload());
    expect(utils.props.onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the recording when the download fails and checks it after a retry', async () => {
    const downloadModel = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const utils = renderRecorder({ isModelReady: jest.fn(async () => false), downloadModel });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-download')).toBeTruthy());
    fireEvent.press(utils.getByTestId('voice-enrollment-download'));

    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-download-retry')).toBeTruthy());
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-download-retry'));
    });

    await waitFor(() =>
      expect(utils.props.onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          recordings: [{ uri: 'file://sample.wav', mimeType: 'audio/wav' }],
        }),
      ),
    );
  });

  it('stops waiting on a stalled download, and Retry checks the kept recording once it lands', async () => {
    let finishDownload: () => void = () => {};
    const stalled = new Promise<void>((resolve) => (finishDownload = resolve));
    const downloadModel = jest.fn(() => stalled);
    const utils = renderRecorder({ isModelReady: jest.fn(async () => false), downloadModel });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-download')).toBeTruthy());
    fireEvent.press(utils.getByTestId('voice-enrollment-download'));
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    await act(async () => {
      jest.advanceTimersByTime(3 * 60 * 1000);
    });
    expect(utils.getByTestId('voice-enrollment-download-retry')).toBeTruthy();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-download-retry'));
    });
    await act(async () => finishDownload());

    await waitFor(() => expect(utils.props.onSubmit).toHaveBeenCalledTimes(1));
  });

  it('keeps Done off until 15 seconds and stops by itself at 30', async () => {
    const utils = renderRecorder();
    await recordFor(utils, 14);
    expect(utils.getByTestId('voice-enrollment-stop').props.accessibilityState.disabled).toBe(true);
    expect(utils.getByText('Keep reading')).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(utils.getByTestId('voice-enrollment-stop').props.accessibilityState.disabled).toBe(
      false,
    );
    expect(utils.queryByText('Keep reading')).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(14_000);
    });
    expect(stopRecordingRaw).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await waitFor(() => expect(stopRecordingRaw).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(utils.props.onSubmit).toHaveBeenCalledTimes(1));
  });

  it('stops and submits once when the 30 s limit lands while Done is still stopping', async () => {
    let finishStop: (uri: string) => void = () => {};
    stopRecordingRaw.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finishStop = resolve)),
    );
    const utils = renderRecorder();
    await recordFor(utils, 29);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });
    // Still recording while the stop is in flight, so the auto-stop fires as well.
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await act(async () => finishStop('file://sample.wav'));

    await waitFor(() => expect(utils.props.onSubmit).toHaveBeenCalledTimes(1));
    expect(stopRecordingRaw).toHaveBeenCalledTimes(1);
  });

  it('submits one sample with the consent time and shows success', async () => {
    const utils = renderRecorder();
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    await waitFor(() =>
      expect(utils.props.onSubmit).toHaveBeenCalledWith({
        recordings: [{ uri: 'file://sample.wav', mimeType: 'audio/wav' }],
        displayName: 'Me',
        isOwner: true,
        consentAccepted: true,
        consentAcceptedAt: '2026-09-27T09:00:00.000Z',
      }),
    );
    expect(utils.getByText('Future on-device meetings will label you as Me.')).toBeTruthy();
    fireEvent.press(utils.getByTestId('voice-enrollment-done'));
    expect(utils.props.onDone).toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://sample.wav', { idempotent: true });
  });

  it('explains a failed sample and lets you try again', async () => {
    const onSubmit = jest.fn(async () => {
      throw new VoiceEnrollmentError(VOICE_ENROLLMENT_LOW_SNR, 'snr');
    });
    const utils = renderRecorder({ onSubmit });
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    await waitFor(() =>
      expect(utils.getByText('Too much background noise. Try somewhere quieter.')).toBeTruthy(),
    );
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://sample.wav', { idempotent: true });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    fireEvent.press(utils.getByTestId('voice-enrollment-try-again'));
    expect(utils.queryByTestId('voice-enrollment-error')).toBeNull();
    expect(utils.getByTestId('voice-enrollment-record')).toBeTruthy();
  });

  it('reports a failure it cannot explain', async () => {
    const error = new VoiceEnrollmentError(VOICE_ENROLLMENT_STORAGE_FAILED, 'disk');
    const utils = renderRecorder({
      onSubmit: jest.fn(async () => {
        throw error;
      }),
    });
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    await waitFor(() => expect(utils.getByText(/something went wrong/i)).toBeTruthy());
    expect(Sentry.captureException).toHaveBeenCalledWith(error, expect.anything());
  });

  it('deletes the sample and shows no failure when you already have a voice profile', async () => {
    const utils = renderRecorder({
      onSubmit: jest.fn(async () => {
        throw new SpeakerProfileOwnerAlreadyExistsError();
      }),
    });
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    await waitFor(() =>
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://sample.wav', {
        idempotent: true,
      }),
    );
    expect(utils.queryByTestId('voice-enrollment-error')).toBeNull();
  });

  it('keeps the read when the model turns out to be missing, and checks it after the download', async () => {
    const onSubmit = jest
      .fn()
      .mockRejectedValueOnce(
        new VoiceEnrollmentError(VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED, 'x'),
      )
      .mockResolvedValueOnce(undefined);
    const utils = renderRecorder({ onSubmit });
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-download')).toBeTruthy());
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-download'));
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        recordings: [{ uri: 'file://sample.wav', mimeType: 'audio/wav' }],
      }),
    );
    expect(utils.props.downloadModel).toHaveBeenCalledTimes(1);
  });

  it('checks the kept recording once when Retry is tapped twice', async () => {
    const downloadModel = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const utils = renderRecorder({ isModelReady: jest.fn(async () => false), downloadModel });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-download')).toBeTruthy());
    fireEvent.press(utils.getByTestId('voice-enrollment-download'));
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-download-retry')).toBeTruthy());

    await act(async () => {
      const retry = utils.getByTestId('voice-enrollment-download-retry');
      fireEvent.press(retry);
      fireEvent.press(retry);
    });

    await waitFor(() => expect(utils.props.onSubmit).toHaveBeenCalledTimes(1));
    expect(downloadModel).toHaveBeenCalledTimes(2);
  });

  it('retries a failed download from the read screen without checking anything', async () => {
    const downloadModel = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const utils = renderRecorder({ isModelReady: jest.fn(async () => false), downloadModel });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-download')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-download'));
    });
    await waitFor(() =>
      expect(utils.getByTestId('voice-enrollment-download-retry-inline')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-download-retry-inline'));
    });

    expect(downloadModel).toHaveBeenCalledTimes(2);
    expect(utils.queryByTestId('voice-enrollment-download-retry-inline')).toBeNull();
    expect(utils.props.onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the profile name on a retrain', async () => {
    const utils = renderRecorder({ isOwner: false, profileId: 5, defaultDisplayName: 'Alice' });
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    await waitFor(() =>
      expect(utils.props.onSubmit).toHaveBeenCalledWith({
        recordings: [{ uri: 'file://sample.wav', mimeType: 'audio/wav' }],
        profileId: 5,
        consentAccepted: true,
        consentAcceptedAt: '2026-09-27T09:00:00.000Z',
      }),
    );
    expect(utils.queryByTestId('voice-enrollment-name')).toBeNull();
  });

  it('points to Settings when iOS can no longer ask for the microphone', async () => {
    startRecording.mockRejectedValueOnce(
      new MicPermissionError('denied', { canAskAgain: false, nativePromptShown: false }),
    );
    const utils = renderRecorder();
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-record')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-record'));
    });

    expect(showMicPermissionAlert).toHaveBeenCalledTimes(1);
    expect(utils.getByText(/check that OpenWhispr can use it in Settings/i)).toBeTruthy();
  });

  it('shows a failure and Try Again when the microphone cannot start', async () => {
    startRecording.mockRejectedValueOnce(new Error('Microphone permission denied'));
    const utils = renderRecorder();
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-record')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-record'));
    });

    expect(utils.getByTestId('voice-enrollment-error')).toBeTruthy();
    expect(utils.getByText("Couldn't start the microphone. Try again.")).toBeTruthy();
    expect(utils.getByTestId('voice-enrollment-try-again')).toBeTruthy();
    expect(showMicPermissionAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('says a call interrupted the read as soon as the recorder pauses', async () => {
    const recorder = {
      uri: 'file://partial.wav',
      isRecording: true,
      stop: jest.fn(async () => {}),
    };
    mockUseAudioRecording.mockReturnValue({
      ...mockUseAudioRecording(),
      audioRecorder: recorder as unknown as ReturnType<typeof useAudioRecording>['audioRecorder'],
    });
    const utils = renderRecorder();
    await recordFor(utils, 5);

    recorder.isRecording = false;
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(utils.getByText(/interrupted/i)).toBeTruthy();
    expect(recorder.stop).toHaveBeenCalled();
    await waitFor(() =>
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://partial.wav', {
        idempotent: true,
      }),
    );
    expect(stopRecordingRaw).not.toHaveBeenCalled();
    expect(utils.props.onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the time you first started reading as the consent time across Try Again', async () => {
    const now = jest
      .fn()
      .mockReturnValueOnce(new Date('2026-09-27T09:00:00.000Z'))
      .mockReturnValue(new Date('2026-09-27T09:05:00.000Z'));
    const onSubmit = jest
      .fn()
      .mockRejectedValueOnce(new VoiceEnrollmentError(VOICE_ENROLLMENT_LOW_SNR, 'snr'))
      .mockResolvedValueOnce(undefined);
    const utils = renderRecorder({ now, onSubmit });
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-try-again')).toBeTruthy());
    fireEvent.press(utils.getByTestId('voice-enrollment-try-again'));
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ consentAcceptedAt: '2026-09-27T09:00:00.000Z' }),
    );
  });

  it('joins a download already running instead of asking again', async () => {
    const downloadModel = jest.fn(() => new Promise<void>(() => {}));
    const isModelReady = jest.fn(async () => false);
    const utils = renderRecorder({
      isModelReady,
      isModelDownloading: jest.fn(() => true),
      downloadModel,
    });

    await waitFor(() => expect(utils.getByTestId('voice-enrollment-record')).toBeTruthy());
    expect(utils.queryByText('Download the speaker model')).toBeNull();
    expect(utils.getByTestId('voice-enrollment-downloading')).toBeTruthy();
    expect(downloadModel).toHaveBeenCalledTimes(1);
  });

  it('stops the download wait when you leave', async () => {
    const downloadModel = jest.fn(() => new Promise<void>(() => {}));
    const utils = renderRecorder({ isModelReady: jest.fn(async () => false), downloadModel });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-download')).toBeTruthy());
    fireEvent.press(utils.getByTestId('voice-enrollment-download'));
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });
    expect(utils.getByTestId('voice-enrollment-checking')).toBeTruthy();

    const timersWhileWaiting = jest.getTimerCount();
    utils.unmount();
    await act(async () => undefined);

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://sample.wav', { idempotent: true });
    // The 3-minute wait timer goes with the screen (unmounting schedules one of its own).
    expect(jest.getTimerCount()).toBeLessThanOrEqual(timersWhileWaiting);
  });

  it("labels a retrained profile of yours by the profile's name", async () => {
    const utils = renderRecorder({ profileId: 3, defaultDisplayName: 'Chad' });
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    await waitFor(() =>
      expect(utils.getByText('Future on-device meetings will label you as Chad.')).toBeTruthy(),
    );
  });

  it('cancels the recording and deletes it when you leave mid-read', async () => {
    mockUseAudioRecording.mockReturnValue({
      ...mockUseAudioRecording(),
      audioRecorder: { uri: 'file://partial.wav', isRecording: true } as ReturnType<
        typeof useAudioRecording
      >['audioRecorder'],
    });
    const utils = renderRecorder();
    await recordFor(utils, 5);
    utils.unmount();
    expect(cancelRecording).toHaveBeenCalled();

    await act(async () => undefined);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://partial.wav', { idempotent: true });
  });

  it('deletes the recording and never submits it when you leave while it is stopping', async () => {
    let finishStop: (uri: string) => void = () => {};
    stopRecordingRaw.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finishStop = resolve)),
    );
    const utils = renderRecorder();
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    utils.unmount();
    await act(async () => finishStop('file://sample.wav'));

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://sample.wav', { idempotent: true });
    expect(utils.props.onSubmit).not.toHaveBeenCalled();
  });

  it('deletes the sample when you leave mid-read, after the recorder is released', async () => {
    mockReleasingRecorder();
    const utils = renderRecorder();
    await recordFor(utils, 5);

    utils.unmount();
    await act(async () => undefined);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://partial.wav', { idempotent: true });
  });

  it('deletes the sample when you leave mid-stop, after the recorder is released', async () => {
    let finishStop: () => void = () => {};
    mockReleasingRecorder(() => new Promise<void>((resolve) => (finishStop = resolve)));
    const utils = renderRecorder();
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    utils.unmount();
    await act(async () => finishStop());

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://partial.wav', { idempotent: true });
    expect(utils.props.onSubmit).not.toHaveBeenCalled();
  });

  it('never deletes a sample already handed to onSubmit when you leave', async () => {
    let finishSubmit: () => void = () => {};
    mockReleasingRecorder();
    const onSubmit = jest.fn(() => new Promise<void>((resolve) => (finishSubmit = resolve)));
    const utils = renderRecorder({ onSubmit });
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    utils.unmount();
    await act(async () => undefined);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();

    await act(async () => finishSubmit());
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['returns no file', async () => null, /interrupted/i],
    [
      'fails',
      async () => {
        throw new Error('stop failed');
      },
      /couldn't finish the recording/i,
    ],
  ])(
    'deletes the sample and shows a failure when stopping %s',
    async (_label, stopResult, message) => {
      stopRecordingRaw.mockImplementationOnce(stopResult);
      mockUseAudioRecording.mockReturnValue({
        ...mockUseAudioRecording(),
        audioRecorder: { uri: 'file://partial.wav', isRecording: true } as ReturnType<
          typeof useAudioRecording
        >['audioRecorder'],
      });
      const utils = renderRecorder();
      await recordFor(utils, 15);
      await act(async () => {
        fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
      });

      expect(utils.getByTestId('voice-enrollment-error')).toBeTruthy();
      expect(utils.getByText(message)).toBeTruthy();
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://partial.wav', {
        idempotent: true,
      });
      expect(utils.props.onSubmit).not.toHaveBeenCalled();
    },
  );

  it('starts one recording when the mic is tapped twice while it opens', async () => {
    let finishStart: () => void = () => {};
    startRecording.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishStart = () => resolve(undefined))),
    );
    const utils = renderRecorder();
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-record')).toBeTruthy());

    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-record'));
      fireEvent.press(utils.getByTestId('voice-enrollment-record'));
    });
    await act(async () => finishStart());

    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(utils.getByTestId('voice-enrollment-stop')).toBeTruthy();
  });

  it("needs a name before recording someone else's voice", async () => {
    const utils = renderRecorder({ isOwner: false });
    await waitFor(() => expect(utils.getByTestId('voice-enrollment-record')).toBeTruthy());
    expect(utils.getByTestId('voice-enrollment-record').props.accessibilityState.disabled).toBe(
      true,
    );

    fireEvent.changeText(utils.getByTestId('voice-enrollment-name'), 'Alice');
    await recordFor(utils, 15);
    await act(async () => {
      fireEvent.press(utils.getByTestId('voice-enrollment-stop'));
    });

    await waitFor(() =>
      expect(utils.props.onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Alice', isOwner: false }),
      ),
    );
    expect(utils.getByText('Future on-device meetings will label Alice.')).toBeTruthy();
  });
});
