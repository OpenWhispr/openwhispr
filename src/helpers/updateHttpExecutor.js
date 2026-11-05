const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor");
const { CancellationError } = require("builder-util-runtime");

class UpdateHttpExecutor extends ElectronHttpExecutor {
  requests = new Map();
  suspended = false;

  createRequest(options, callback) {
    const request = super.createRequest(options, (response) => {
      for (const event of ["end", "close", "error", "aborted"]) {
        response.once(event, () => this.requests.delete(request));
      }
      callback(response);
      if (response.readableFlowing === null) response.resume();
    });
    this.requests.set(request, null);
    // Electron can emit request "close" before the response even arrives.
    for (const event of ["error", "abort"]) {
      request.once(event, () => this.requests.delete(request));
    }
    if (this.suspended) request.abort();
    return request;
  }

  addRedirectHandlers(request, ...args) {
    request.once("redirect", () => this.requests.delete(request));
    super.addRedirectHandlers(request, ...args);
  }

  addErrorAndTimeoutHandlers(request, reject, timeout) {
    super.addErrorAndTimeoutHandlers(request, reject, timeout);
    if (this.suspended) {
      this.requests.delete(request);
      reject(new CancellationError());
    } else {
      this.requests.set(request, reject);
    }
  }

  resumeRequests() {
    this.suspended = false;
  }

  abortRequests() {
    this.suspended = true;
    for (const [request, reject] of this.requests) {
      try {
        request.abort();
      } catch (error) {
        console.error("Failed to abort update request:", error);
      }
      reject?.(new CancellationError());
    }
    this.requests.clear();
  }
}

module.exports = UpdateHttpExecutor;
