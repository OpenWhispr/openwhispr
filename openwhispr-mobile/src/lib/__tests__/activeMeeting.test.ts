import {
  activeMeetingNoteId,
  isMeetingActive,
  registerActiveMeeting,
  stopActiveMeeting,
} from '@/lib/notes/activeMeeting';

afterEach(() => registerActiveMeeting(null));

describe('activeMeeting', () => {
  it('stopActiveMeeting is a no-op when idle', async () => {
    await expect(stopActiveMeeting()).resolves.toBeUndefined();
    const stop = jest.fn().mockResolvedValue(undefined);
    registerActiveMeeting({ isActive: () => false, stop, noteId: () => null });
    await stopActiveMeeting();
    expect(stop).not.toHaveBeenCalled();
    expect(isMeetingActive()).toBe(false);
  });

  it('delegates to the registered handle', async () => {
    const stop = jest.fn().mockResolvedValue(undefined);
    registerActiveMeeting({ isActive: () => true, stop, noteId: () => 42 });
    expect(isMeetingActive()).toBe(true);
    await stopActiveMeeting();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('forgets an unregistered handle', () => {
    registerActiveMeeting({ isActive: () => true, stop: jest.fn(), noteId: () => 42 });
    registerActiveMeeting(null);
    expect(isMeetingActive()).toBe(false);
  });

  it('names the live note only while a meeting is active', () => {
    expect(activeMeetingNoteId()).toBeNull();
    let active = true;
    registerActiveMeeting({ isActive: () => active, stop: jest.fn(), noteId: () => 42 });
    expect(activeMeetingNoteId()).toBe(42);
    active = false;
    expect(activeMeetingNoteId()).toBeNull();
  });
});
