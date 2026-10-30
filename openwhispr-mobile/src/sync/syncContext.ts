export class SyncCancelledError extends Error {
  constructor() {
    super('Sync context changed');
    this.name = 'SyncCancelledError';
  }
}

export type SyncCheckpoint = (upload?: boolean) => void;
export const uncheckedSync: SyncCheckpoint = (): void => {};

// A paged pull whose server keeps returning the same keyset boundary. Saving
// that boundary would freeze the pull for good, and it is never a network blip,
// so callers must report it rather than file it as offline.
export class SyncStalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncStalledError';
  }
}
