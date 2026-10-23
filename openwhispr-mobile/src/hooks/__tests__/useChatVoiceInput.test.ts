import { act, renderHook } from '@testing-library/react-native';
import { AccessibilityInfo, Alert } from 'react-native';
import type { UseAudioRecordingOptions } from '../useAudioRecording';

jest.mock('@/data', () => ({ chatRepository: {} }));
jest.mock('@/lib/chat/runChatTurn', () => ({ runChatTurn: jest.fn() }));
jest.mock('@/components/ui/PermissionAlert', () => ({ showPermissionAlert: jest.fn() }));
jest.mock('@/lib/privateMode', () => ({ promptLocalModelFallback: jest.fn() }));
jest.mock('@/lib/utils', () => ({
  ...jest.requireActual<typeof import('@/lib/utils')>('@/lib/utils'),
  safeHaptics: jest.fn(),
}));
let mockConfig: { noteChatEnabled?: boolean; inference: { noteChat: { mode: string } } } = {
  inference: { noteChat: { mode: 'local' } },
};
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));
let mockActiveMode = 'private';
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));
const mockLoadUsage = jest.fn();
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ load: mockLoadUsage }) },
}));
const mockHandleUsageLimitReached = jest.fn(async () => undefined);
jest.mock('@/hooks/useUsageLimitRecovery', () => ({
  useUsageLimitRecovery: () => ({
    handleUsageLimitReached: mockHandleUsageLimitReached,
    isRecoveringUsageLimit: false,
  }),
}));

// The recorder is driven by hand: each test decides what stopping it produces.
let mockRecordingOptions: UseAudioRecordingOptions = {};
let mockIsRecording = false;
let mockIsProcessing = false;
let mockStopBehavior: () => Promise<void> = async () => undefined;
// The recorder keeps reporting recording until its native stop resolves.
let mockNativeStop: Promise<void> = Promise.resolve();
const mockStartRecording = jest.fn(async () => {
  mockIsRecording = true;
});
const mockCancelRecording = jest.fn(async () => {
  mockIsRecording = false;
});
const mockStopRecording = jest.fn(async () => {
  await mockNativeStop;
  mockIsRecording = false;
  await mockStopBehavior();
});
jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: (options: UseAudioRecordingOptions) => {
    mockRecordingOptions = options;
    return {
      isRecording: mockIsRecording,
      isProcessing: mockIsProcessing,
      startRecording: mockStartRecording,
      stopRecording: mockStopRecording,
      cancelRecording: mockCancelRecording,
      audioRecorder: {},
    };
  },
}));

import { useChatStore } from '@/store/useChatStore';
import { promptLocalModelFallback } from '@/lib/privateMode';
import { safeHaptics } from '@/lib/utils';
import { useChatVoiceInput } from '../useChatVoiceInput';

const mockSend = jest.fn();

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const mockOnNotSent = jest.fn();
let mockFocused = true;

const renderVoiceInput = (conversationId: string | null, onSent?: (id: string) => void) =>
  renderHook(() =>
    useChatVoiceInput({
      conversationId,
      onSent,
      onNotSent: mockOnNotSent,
      isFocused: () => mockFocused,
    }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockIsRecording = false;
  mockIsProcessing = false;
  mockFocused = true;
  mockStopBehavior = async () => undefined;
  mockNativeStop = Promise.resolve();
  mockActiveMode = 'private';
  mockConfig = { inference: { noteChat: { mode: 'local' } } };
  useChatStore.getState().reset();
  mockSend.mockReturnValue({ conversationId: 'conv-1', done: Promise.resolve() });
  useChatStore.setState({ send: mockSend });
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

it('does not save the spoken question to transcript history', () => {
  renderVoiceInput('conv-1');
  expect(mockRecordingOptions.saveToHistory).toBe(false);
});

it('sends the transcript as a chat question', async () => {
  const onSent = jest.fn();
  mockStopBehavior = async () => {
    expect(useChatStore.getState().pending).toEqual(
      expect.objectContaining({ phase: 'transcribing', conversationId: 'conv-1' }),
    );
    mockRecordingOptions.onComplete?.('When is my next meeting?');
  };
  const { result, rerender } = renderVoiceInput('conv-1', onSent);

  await act(async () => {
    await result.current.start(true);
  });
  rerender({});
  expect(result.current.state).toBe('listening');
  await act(async () => {
    await result.current.finish();
  });

  expect(mockSend).toHaveBeenCalledWith('When is my next meeting?', {
    conversationId: 'conv-1',
    allowCloudFallback: true,
  });
  expect(onSent).toHaveBeenCalledWith('conv-1');
  expect(useChatStore.getState().pending).toBeNull();
  rerender({});
  expect(result.current.state).toBe('idle');
});

it('hands the transcript back instead of sending when the chat route changed', async () => {
  mockStopBehavior = async () => {
    mockActiveMode = 'cloud';
    mockRecordingOptions.onComplete?.('When is my next meeting?');
  };
  const { result, rerender } = renderVoiceInput('conv-1');

  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  await act(async () => {
    await result.current.finish();
  });

  expect(mockSend).not.toHaveBeenCalled();
  expect(mockOnNotSent).toHaveBeenCalledWith('When is my next meeting?');
  expect(useChatStore.getState().pending).toBeNull();
});

it('hands the transcript back instead of sending when Chat was turned off', async () => {
  mockStopBehavior = async () => {
    mockConfig = { ...mockConfig, noteChatEnabled: false };
    mockRecordingOptions.onComplete?.('When is my next meeting?');
  };
  const { result, rerender } = renderVoiceInput('conv-1');

  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  await act(async () => {
    await result.current.finish();
  });

  expect(mockSend).not.toHaveBeenCalled();
  expect(mockOnNotSent).toHaveBeenCalledWith('When is my next meeting?');
});

it('hands the transcript back when a failed chat wipe refuses the send, and only then', async () => {
  const speak = async (): Promise<void> => {
    const { result, rerender } = renderVoiceInput('conv-1');
    await act(async () => {
      await result.current.start(false);
    });
    rerender({});
    await act(async () => {
      await result.current.finish();
    });
  };
  mockStopBehavior = async () => {
    mockRecordingOptions.onComplete?.('When is my next meeting?');
  };

  mockSend.mockImplementationOnce(() => {
    useChatStore.setState({ sendBlockedByWipe: true });
    return null;
  });
  await speak();
  expect(mockOnNotSent).toHaveBeenCalledWith('When is my next meeting?');

  mockOnNotSent.mockClear();
  useChatStore.setState({ sendBlockedByWipe: false });
  mockSend.mockReturnValueOnce(null);
  await speak();
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockOnNotSent).not.toHaveBeenCalled();
});

it('opens one recording for two quick taps', async () => {
  const { result } = renderVoiceInput('conv-1');

  let started: boolean[] = [];
  await act(async () => {
    started = await Promise.all([result.current.start(false), result.current.start(false)]);
  });

  expect(started).toEqual([true, false]);
  expect(mockStartRecording).toHaveBeenCalledTimes(1);
});

it('closes a mic that opened after the screen was left', async () => {
  mockStartRecording.mockImplementationOnce(async () => {
    mockIsRecording = true;
    mockFocused = false;
  });
  const { result } = renderVoiceInput('conv-1');

  let started = true;
  await act(async () => {
    started = await result.current.start(false);
  });

  expect(started).toBe(false);
  expect(mockCancelRecording).toHaveBeenCalledTimes(1);
});

it('reports a refused start when the mic it opened late won’t close', async () => {
  mockStartRecording.mockImplementationOnce(async () => {
    mockIsRecording = true;
    mockFocused = false;
  });
  mockCancelRecording.mockRejectedValueOnce(new Error('stop failed'));
  const { result } = renderVoiceInput('conv-1');

  let started: Promise<boolean> = Promise.resolve(true);
  await act(async () => {
    started = result.current.start(false);
    await started.catch(() => undefined);
  });

  await expect(started).resolves.toBe(false);
});

it('reports settling while a cancelled question is still transcribing', () => {
  mockIsProcessing = true;
  const { result } = renderVoiceInput('conv-1');

  expect(result.current.state).toBe('idle');
  expect(result.current.isSettling).toBe(true);
});

it('ignores a transcript that arrives after cancel', async () => {
  const transcription = deferred();
  mockStopBehavior = async () => {
    await transcription.promise;
    mockRecordingOptions.onComplete?.('Too late');
  };
  const { result, rerender } = renderVoiceInput(null);

  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  let finishing: Promise<void> = Promise.resolve();
  await act(async () => {
    finishing = result.current.finish();
  });
  expect(result.current.state).toBe('transcribing');

  await act(async () => {
    await result.current.cancel();
  });
  expect(useChatStore.getState().pending).toBeNull();
  await act(async () => {
    transcription.resolve();
    await finishing;
  });

  expect(mockSend).not.toHaveBeenCalled();
  expect(useChatStore.getState().pending).toBeNull();
  rerender({});
  expect(result.current.state).toBe('idle');
});

it('sends nothing when no speech was heard', async () => {
  mockStopBehavior = async () => {
    const error = new Error('No speech detected');
    mockRecordingOptions.onError?.(error);
    throw error;
  };
  const { result, rerender } = renderVoiceInput('conv-1');

  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  await act(async () => {
    await result.current.finish();
  });

  expect(mockSend).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(useChatStore.getState().pending).toBeNull();
});

it('says no speech was heard until the next question', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  mockStopBehavior = async () => {
    const error = new Error('No speech detected');
    mockRecordingOptions.onError?.(error);
    throw error;
  };
  const { result, rerender } = renderVoiceInput('conv-1');
  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  expect(result.current.noSpeechHeard).toBe(false);

  await act(async () => {
    await result.current.finish();
  });

  expect(result.current.noSpeechHeard).toBe(true);
  expect(announce).toHaveBeenCalledWith('No speech detected');
  await act(async () => {
    await result.current.start(false);
  });
  expect(result.current.noSpeechHeard).toBe(false);
});

// Stops a question while it transcribes, then lets its transcription report `report`.
const stopWhileTranscribing = async (report: () => Promise<void> | void): Promise<void> => {
  const transcription = deferred();
  mockStopBehavior = async () => {
    await transcription.promise;
    await report();
  };
  const { result, rerender } = renderVoiceInput('conv-1');
  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  let finishing: Promise<void> = Promise.resolve();
  await act(async () => {
    finishing = result.current.finish();
  });
  await act(async () => {
    await result.current.cancel();
  });
  await act(async () => {
    transcription.resolve();
    await finishing.catch(() => undefined);
  });
};

it('drops a stopped question instead of offering the cloud for it', async () => {
  const discard = jest.fn(async () => undefined);

  await stopWhileTranscribing(() => mockRecordingOptions.onLocalModelMissing?.(jest.fn(), discard));

  expect(promptLocalModelFallback).not.toHaveBeenCalled();
  expect(discard).toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it('shows no paywall for a stopped question', async () => {
  await stopWhileTranscribing(() =>
    mockRecordingOptions.onUsageLimitReached?.(
      Object.assign(new Error('limit'), { source: 'dictation' }) as never,
      async () => undefined,
    ),
  );

  expect(mockHandleUsageLimitReached).not.toHaveBeenCalled();
});

it('shows no error for a stopped question', async () => {
  await stopWhileTranscribing(() => {
    const error = new Error('Network down');
    mockRecordingOptions.onError?.(error);
    throw error;
  });

  expect(Alert.alert).not.toHaveBeenCalled();
});

it('stops showing a cloud retry whose entry was cleared under it', async () => {
  const { result, rerender } = renderVoiceInput('conv-1');
  mockRecordingOptions.onLocalModelMissing?.(
    jest.fn(),
    jest.fn(async () => undefined),
  );
  const [onUseCloud] = jest.mocked(promptLocalModelFallback).mock.calls[0];
  act(() => onUseCloud());
  rerender({});
  expect(result.current.state).toBe('transcribing');

  // A sign-out resets the store while the retry transcribes.
  act(() => useChatStore.getState().reset());
  act(() => mockRecordingOptions.onComplete?.('Too late'));
  rerender({});

  expect(result.current.state).toBe('idle');
  expect(mockSend).not.toHaveBeenCalled();
});

it('reports other failures and releases the transcribing slot', async () => {
  mockStopBehavior = async () => {
    const error = new Error('Network down');
    mockRecordingOptions.onError?.(error);
    throw error;
  };
  const { result, rerender } = renderVoiceInput('conv-1');

  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  await act(async () => {
    await result.current.finish();
  });

  expect(Alert.alert).toHaveBeenCalledWith('Couldn’t hear that', 'Network down');
  expect(mockSend).not.toHaveBeenCalled();
  expect(useChatStore.getState().pending).toBeNull();
});

it('drops the transcript when another turn took over the slot', async () => {
  mockStopBehavior = async () => {
    useChatStore.getState().cancel();
    useChatStore.getState().beginTranscribing('conv-1');
    mockRecordingOptions.onComplete?.('Stale question');
  };
  const { result, rerender } = renderVoiceInput('conv-1');

  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  await act(async () => {
    await result.current.finish();
  });

  expect(mockSend).not.toHaveBeenCalled();
  // The slot belongs to whoever took it over, so it stays theirs.
  expect(useChatStore.getState().pending?.phase).toBe('transcribing');
});

it('cancels the recording when a chat turn is already running', async () => {
  const { result, rerender } = renderVoiceInput('conv-1');
  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  useChatStore.getState().beginTranscribing('conv-2');

  await act(async () => {
    await result.current.finish();
  });

  expect(mockCancelRecording).toHaveBeenCalled();
  expect(mockStopRecording).not.toHaveBeenCalled();
  expect(useChatStore.getState().pending?.conversationId).toBe('conv-2');
  expect(safeHaptics).toHaveBeenCalledWith('light');
});

it('does not start while a chat turn is running', async () => {
  useChatStore.getState().beginTranscribing('conv-2');
  const { result } = renderVoiceInput('conv-1');

  let started: boolean | undefined;
  await act(async () => {
    started = await result.current.start(false);
  });

  expect(started).toBe(false);
  expect(mockStartRecording).not.toHaveBeenCalled();
});

it('reports that recording started', async () => {
  const { result } = renderVoiceInput('conv-1');

  let started: boolean | undefined;
  await act(async () => {
    started = await result.current.start(false);
  });

  expect(started).toBe(true);
});

it('cancel during the stop window sends nothing', async () => {
  const nativeStop = deferred();
  mockNativeStop = nativeStop.promise;
  mockStopBehavior = async () => {
    mockRecordingOptions.onComplete?.('Cancelled question');
  };
  const { result, rerender } = renderVoiceInput('conv-1');
  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  let finishing: Promise<void> = Promise.resolve();
  await act(async () => {
    finishing = result.current.finish();
  });
  expect(result.current.state).toBe('transcribing');

  await act(async () => {
    await result.current.cancel();
  });
  expect(useChatStore.getState().pending).toBeNull();
  await act(async () => {
    nativeStop.resolve();
    await finishing;
  });

  expect(mockCancelRecording).toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(useChatStore.getState().pending).toBeNull();
  rerender({});
  expect(result.current.state).toBe('idle');
});

it('a second finish while stopping does nothing', async () => {
  const nativeStop = deferred();
  mockNativeStop = nativeStop.promise;
  mockStopBehavior = async () => {
    mockRecordingOptions.onComplete?.('Only once');
  };
  const { result, rerender } = renderVoiceInput('conv-1');
  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  let finishing: Promise<void> = Promise.resolve();
  await act(async () => {
    finishing = result.current.finish();
  });

  await act(async () => {
    await result.current.finish();
  });
  await act(async () => {
    nativeStop.resolve();
    await finishing;
  });

  expect(mockStopRecording).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockCancelRecording).not.toHaveBeenCalled();
});

it('discards the recording when the local-model fallback is declined', () => {
  renderVoiceInput('conv-1');
  const discard = jest.fn(async () => undefined);
  mockRecordingOptions.onLocalModelMissing?.(jest.fn(), discard);

  const [, onDecline] = jest.mocked(promptLocalModelFallback).mock.calls[0];
  onDecline?.();

  expect(discard).toHaveBeenCalled();
});

it('refreshes usage after a cloud transcription', () => {
  mockActiveMode = 'cloud';
  renderVoiceInput('conv-1');

  mockRecordingOptions.onComplete?.('Anything');

  expect(mockLoadUsage).toHaveBeenCalledWith(true);
});

it('stops the recorder when cancelled while listening', async () => {
  const { result, rerender } = renderVoiceInput('conv-1');
  await act(async () => {
    await result.current.start(false);
  });
  rerender({});

  await act(async () => {
    await result.current.cancel();
  });

  expect(mockCancelRecording).toHaveBeenCalled();
  expect(useChatStore.getState().pending).toBeNull();
});

it('releases the slot once usage-limit recovery ends without a retry', async () => {
  mockStopBehavior = async () => {
    await mockRecordingOptions.onUsageLimitReached?.(
      Object.assign(new Error('limit'), { source: 'dictation' }) as never,
      async () => undefined,
    );
  };
  const { result, rerender } = renderVoiceInput('conv-1');
  await act(async () => {
    await result.current.start(false);
  });
  rerender({});
  await act(async () => {
    await result.current.finish();
  });

  expect(mockHandleUsageLimitReached).toHaveBeenCalled();
  expect(useChatStore.getState().pending).toBeNull();
});

it('ticks elapsed seconds while listening', async () => {
  jest.useFakeTimers();
  try {
    const { result, rerender } = renderVoiceInput('conv-1');
    await act(async () => {
      await result.current.start(false);
    });
    rerender({});
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(result.current.elapsedSeconds).toBe(3);
  } finally {
    jest.useRealTimers();
  }
});
