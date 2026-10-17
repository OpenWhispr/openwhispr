// Keep speech and text inference serial so their weights do not compete for phone memory.
let queue: Promise<unknown> = Promise.resolve();
export function withAndroidInference<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.catch(() => undefined);
  return result;
}
