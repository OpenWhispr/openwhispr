export class PreparedMicCapture {
  constructor(stopStream = (stream) => stream?.getTracks?.().forEach((track) => track.stop())) {
    this.stopStream = stopStream;
    this.generation = 0;
    this.prepared = null;
    this.pending = null;
  }

  prepare(acquire) {
    if (this.prepared) return Promise.resolve(this.prepared);
    if (this.pending) return this.pending;

    const generation = this.generation;
    const pending = Promise.resolve()
      .then(acquire)
      .then((prepared) => {
        if (generation !== this.generation) {
          this.stopStream(prepared?.stream);
          return null;
        }
        this.prepared = prepared;
        return prepared;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });

    this.pending = pending;
    return pending;
  }

  async take() {
    if (this.pending) {
      try {
        await this.pending;
      } catch {
        // The caller can fall back to a normal acquisition.
      }
    }
    const prepared = this.prepared;
    this.prepared = null;
    this.generation += 1;
    return prepared;
  }

  cancel() {
    this.generation += 1;
    this.stopStream(this.prepared?.stream);
    this.prepared = null;
    this.pending = null;
  }
}
