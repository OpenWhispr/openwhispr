const AUTHORIZATION_BOUNDARY_CHANGED = "AUTHORIZATION_BOUNDARY_CHANGED";

function authorizationChangedError() {
  return Object.assign(new Error("Transcription authorization changed. Retry the request."), {
    code: AUTHORIZATION_BOUNDARY_CHANGED,
  });
}

function createManagedTranscriptionOperationRegistry({ isBindingCurrent }) {
  const operations = new Set();

  const begin = ({ family, binding, ownerWebContents = null, onRevoke = () => {} }) => {
    const controller = new AbortController();
    let released = false;
    let revokeNotified = false;

    const detachOwner = () => {
      ownerWebContents?.removeListener?.("destroyed", revoke);
      ownerWebContents?.removeListener?.("render-process-gone", revoke);
    };
    const revoke = () => {
      if (released || controller.signal.aborted) return;
      const error = authorizationChangedError();
      controller.abort(error);
      if (!revokeNotified) {
        revokeNotified = true;
        onRevoke(error);
      }
      operations.delete(operation);
      detachOwner();
    };
    const isCurrent = () =>
      !released && !controller.signal.aborted && isBindingCurrent(binding) === true;
    const assertCurrent = () => {
      if (isCurrent()) return;
      throw controller.signal.reason?.code === AUTHORIZATION_BOUNDARY_CHANGED
        ? controller.signal.reason
        : authorizationChangedError();
    };
    const release = () => {
      if (released) return;
      released = true;
      operations.delete(operation);
      detachOwner();
    };

    const operation = Object.freeze({
      family,
      binding,
      ownerWebContents,
      signal: controller.signal,
      assertCurrent,
      isCurrent,
      release,
      revoke,
    });
    operations.add(operation);
    ownerWebContents?.once?.("destroyed", revoke);
    ownerWebContents?.once?.("render-process-gone", revoke);
    if (ownerWebContents?.isDestroyed?.()) revoke();
    return operation;
  };

  const revoke = ({ identityKey = null, predicate = null } = {}) => {
    for (const operation of operations) {
      if (identityKey && operation.binding?.identityKey !== identityKey) continue;
      if (predicate && !predicate(operation)) continue;
      operation.revoke();
    }
  };

  return { begin, revoke };
}

module.exports = {
  createManagedTranscriptionOperationRegistry,
};
