const { deferred } = require("./deferred");

// Collects the binary audio a loopback provider receives. node:test has no
// default timeout, so the wait is bounded: withheld audio must fail the run
// rather than hang it.
function audioRecorder() {
  const chunks = [];
  let bytes = 0;
  let onChunk = () => {};
  return {
    record(data) {
      chunks.push(data);
      bytes += data.length;
      onChunk();
    },
    // Everything received, in order, once `expectedBytes` have arrived.
    async received(expectedBytes) {
      const arrived = deferred();
      onChunk = () => {
        if (bytes >= expectedBytes) arrived.resolve();
      };
      onChunk();
      await Promise.race([
        arrived.promise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`only ${bytes} of ${expectedBytes} bytes reached the server`)),
            2000
          ).unref()
        ),
      ]);
      return Buffer.concat(chunks);
    },
  };
}

module.exports = { audioRecorder };
