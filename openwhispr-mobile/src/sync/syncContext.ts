export class SyncCancelledError extends Error {
  constructor() {
    super('Sync context changed');
    this.name = 'SyncCancelledError';
  }
}

export type SyncCheckpoint = (upload?: boolean) => void;
export const uncheckedSync: SyncCheckpoint = (): void => {};
