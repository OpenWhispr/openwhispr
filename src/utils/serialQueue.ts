// Runs enqueued async tasks strictly one at a time, in enqueue order. A
// rejected task rejects its own returned promise but never stalls the queue.
export function createSerialQueue(): <Result>(task: () => Promise<Result>) => Promise<Result> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(() => task());
    tail = run.catch(() => undefined);
    return run;
  };
}
