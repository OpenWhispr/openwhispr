export type CreateLibraryLoad = (read: () => void) => () => Promise<void>;

// Keep the read synchronous while reporting failures through the returned promise.
export const createLibraryLoad: CreateLibraryLoad = (read) =>
  async function load() {
    read();
  };
