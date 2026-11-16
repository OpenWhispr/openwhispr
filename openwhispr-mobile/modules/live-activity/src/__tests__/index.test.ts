const mockNative = {
  startSession: jest.fn(),
  endSession: jest.fn(),
  setDictationMode: jest.fn(),
  isDictationModeEnabled: jest.fn(() => true),
  startMeeting: jest.fn(),
  setMeetingProcessing: jest.fn(),
  endMeeting: jest.fn(),
};
const mockRemove = jest.fn();
const mockAddListener = jest.fn((_event: string, _listener: () => void) => ({
  remove: mockRemove,
}));
let mockPlatformOS = 'ios';

jest.mock('expo', () => ({
  requireNativeModule: jest.fn(() => mockNative),
  EventEmitter: jest.fn().mockImplementation(() => ({ addListener: mockAddListener })),
}));
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatformOS;
    },
  },
}));

type Wrapper = typeof import('../index');

function load(os: 'ios' | 'android'): Wrapper {
  mockPlatformOS = os;
  let loaded: Wrapper | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<Wrapper>('../index');
  });
  return loaded as Wrapper;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LiveActivity meeting API on iOS', () => {
  it('passes the trimmed title and epoch-ms start to the native module', () => {
    const { LiveActivity } = load('ios');
    LiveActivity.startMeeting({ title: '  Weekly sync ', startedAt: 1_700_000_000_000 });
    expect(mockNative.startMeeting).toHaveBeenCalledWith('Weekly sync', 1_700_000_000_000);
  });

  it('normalizes a blank title to null', () => {
    const { LiveActivity, normalizeMeetingTitle } = load('ios');
    expect(normalizeMeetingTitle('   ')).toBeNull();
    expect(normalizeMeetingTitle(undefined)).toBeNull();
    LiveActivity.startMeeting({ title: '   ', startedAt: 5 });
    expect(mockNative.startMeeting).toHaveBeenCalledWith(null, 5);
  });

  it('caps a long title at 200 characters with an ellipsis', () => {
    const { normalizeMeetingTitle } = load('ios');
    const exact = 'a'.repeat(200);
    expect(normalizeMeetingTitle(exact)).toBe(exact);
    const capped = normalizeMeetingTitle(`  ${'b'.repeat(500)}  `);
    expect(capped).toHaveLength(200);
    expect(capped).toBe(`${'b'.repeat(199)}…`);
    expect(normalizeMeetingTitle('😀'.repeat(300))).toBe(`${'😀'.repeat(199)}…`);
  });

  it('floors and clamps recorded seconds', () => {
    const { LiveActivity } = load('ios');
    LiveActivity.setMeetingProcessing({ recordedSeconds: 42.9 });
    LiveActivity.setMeetingProcessing({ recordedSeconds: -3 });
    expect(mockNative.setMeetingProcessing).toHaveBeenNthCalledWith(1, 42);
    expect(mockNative.setMeetingProcessing).toHaveBeenNthCalledWith(2, 0);
  });

  it('forwards endMeeting', () => {
    const { LiveActivity } = load('ios');
    LiveActivity.endMeeting();
    expect(mockNative.endMeeting).toHaveBeenCalledTimes(1);
  });

  it('subscribes to onEndMeetingRequested', () => {
    const { LiveActivity } = load('ios');
    const listener = jest.fn();
    const subscription = LiveActivity.addEndMeetingListener(listener);
    expect(mockAddListener).toHaveBeenCalledWith('onEndMeetingRequested', listener);
    subscription.remove();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});

describe('LiveActivity meeting API off iOS', () => {
  it('is a no-op and returns an inert subscription', () => {
    const { LiveActivity } = load('android');
    LiveActivity.startMeeting({ title: 'x', startedAt: 1 });
    LiveActivity.setMeetingProcessing({ recordedSeconds: 1 });
    LiveActivity.endMeeting();
    const subscription = LiveActivity.addEndMeetingListener(jest.fn());
    expect(() => subscription.remove()).not.toThrow();
    expect(mockNative.startMeeting).not.toHaveBeenCalled();
    expect(mockAddListener).not.toHaveBeenCalled();
  });
});
