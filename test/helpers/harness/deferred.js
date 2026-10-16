// A promise with its resolvers exposed, for tests that must hold an async seam
// open (a bounds settle, a display lookup, a provider stop) until the
// assertion point.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

module.exports = { deferred };
