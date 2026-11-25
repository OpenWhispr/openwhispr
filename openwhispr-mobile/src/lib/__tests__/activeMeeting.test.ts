import {
  isMeetingActive,
  registerActiveMeeting,
  stopActiveMeeting,
} from '@/lib/notes/activeMeeting';

afterEach(() => registerActiveMeeting(null));

describe('activeMeeting', () => {
  it('stopActiveMeeting is a no-op when idle', async () => {
    await expect(stopActiveMeeting()).resolves.toBeUndefined();
    const stop = jest.fn().mockResolvedValue(undefined);
    registerActiveMeeting({ isActive: () => false, stop });
    await stopActiveMeeting();
    expect(stop).not.toHaveBeenCalled();
    expect(isMeetingActive()).toBe(false);
  });

  it('delegates to the registered handle', async () => {
    const stop = jest.fn().mockResolvedValue(undefined);
    registerActiveMeeting({ isActive: () => true, stop });
    expect(isMeetingActive()).toBe(true);
    await stopActiveMeeting();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('forgets an unregistered handle', () => {
    registerActiveMeeting({ isActive: () => true, stop: jest.fn() });
    registerActiveMeeting(null);
    expect(isMeetingActive()).toBe(false);
  });
});
