// A promise with its resolver exposed, for tests that must hold an async seam
// open (a bounds settle, a display lookup, a provider stop) until the
// assertion point.
function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

module.exports = { deferred };
