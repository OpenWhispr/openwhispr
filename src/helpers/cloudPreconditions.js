// Every cloud-backed IPC handler needs the same two things before it can call
// the OpenWhispr API: a configured API URL and an authenticated session.
// Neither absence is a failure. A local-only user never configures a URL, and
// the session is not ready during the first paint, so treating them as thrown
// errors logs ERROR-level noise on a healthy launch and hides the reason from
// the renderer. Classify them as expected states instead.

const NOT_CONFIGURED = "NOT_CONFIGURED";
const NOT_AUTHENTICATED = "NOT_AUTHENTICATED";

// Returns { ok: true } when the caller may proceed, otherwise { ok: false,
// result } where `result` is the payload to hand straight back to the renderer.
function checkCloudPreconditions(apiUrl, authHeader) {
  if (!apiUrl) {
    return {
      ok: false,
      result: {
        success: false,
        code: NOT_CONFIGURED,
        error: "OpenWhispr API URL not configured",
      },
    };
  }

  if (!authHeader || Object.keys(authHeader).length === 0) {
    return {
      ok: false,
      result: {
        success: false,
        code: NOT_AUTHENTICATED,
        error: "Not authenticated",
      },
    };
  }

  return { ok: true };
}

module.exports = {
  checkCloudPreconditions,
  NOT_CONFIGURED,
  NOT_AUTHENTICATED,
};
