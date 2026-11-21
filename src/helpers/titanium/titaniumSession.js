// Titanium sign-in for the desktop app (AUTH-02, AUTH-03, AUTH-06).
//
// Flow (titanium-licensing docs/consumer-integration/tauri.md, flow B, with PKCE):
//   1. startSignIn() opens the Titanium hosted login in the browser with
//      return_url = <scheme>://auth/callback?state=..&code_challenge=..&code_challenge_method=S256
//   2. The portal redirects to that URL with ?act=<one-time token>.
//   3. handleCallback() checks state, then POST <portal>/api/exchange
//      {act, app_slug, code_verifier} -> { licenseKey | null, email, appSlug, accountId? }.
//      The response is rejected unless appSlug equals ours (tauri.md MANDATORY). The
//      stable accountId (IDP-32) is the key connector logins are filed under; a login
//      without one is "signed in but unbound" and must sign in again (no email key).
//   4. A non-null licenseKey is verified offline (licenseKey.js); null means signed in
//      without a license for this app (AUTH_ONLY), which is a normal state.
// The session (email + license key) is stored encrypted with Electron safeStorage and
// re-verified offline on every load. It is independent of the OpenWhispr cloud session
// (useAuth stays signed out in this fork, so no hosted-cloud code path turns on).
const crypto = require("crypto");
const fs = require("fs");
const { EventEmitter } = require("events");
const { parseAndVerifyLicenseKey } = require("./licenseKey");

const PENDING_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 15_000;

function base64url(buffer) {
  return buffer.toString("base64url");
}

// The portal omits accountId when it can't resolve one; only a non-empty string counts.
function cleanAccountId(value) {
  return typeof value === "string" && value ? value : null;
}

class TitaniumSession extends EventEmitter {
  constructor({
    config,
    urlScheme,
    filePath,
    encrypt,
    decrypt,
    fetchImpl = globalThis.fetch,
    openExternal,
    now = Date.now,
    randomBytes = crypto.randomBytes,
    fsImpl = fs,
    logger = null,
  }) {
    super();
    this.config = config || {};
    this.urlScheme = urlScheme;
    this.filePath = filePath;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.fetchImpl = fetchImpl;
    this.openExternal = openExternal;
    this.now = now;
    this.randomBytes = randomBytes;
    this.fs = fsImpl;
    this.logger = logger;
    this.pending = null;
    this.session = null;
    this.lastError = null;
    // Bumped by every new sign-in and sign-out, so an exchange still in flight from
    // an older attempt can't install its session afterwards.
    this.generation = 0;
  }

  isConfigured() {
    return Boolean(this.config.portalUrl && this.config.appSlug && this.urlScheme);
  }

  callbackBase() {
    return `${this.urlScheme}://auth/callback`;
  }

  isCallbackUrl(url) {
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === `${this.urlScheme}:` &&
        parsed.hostname === "auth" &&
        parsed.pathname === "/callback"
      );
    } catch {
      return false;
    }
  }

  /** Builds the hosted-login URL and remembers state + PKCE verifier for the callback. */
  buildSignIn() {
    if (!this.isConfigured()) throw new Error("Titanium sign-in is not configured");
    const state = base64url(this.randomBytes(24));
    const verifier = base64url(this.randomBytes(48)); // 64 chars, RFC 7636 alphabet
    const challenge = base64url(crypto.createHash("sha256").update(verifier, "ascii").digest());
    const returnUrl = new URL(this.callbackBase());
    returnUrl.searchParams.set("state", state);
    returnUrl.searchParams.set("code_challenge", challenge);
    returnUrl.searchParams.set("code_challenge_method", "S256");
    const login = new URL("/login", this.config.portalUrl);
    login.searchParams.set("app_id", this.config.appSlug);
    login.searchParams.set("return_url", returnUrl.toString());
    this.generation += 1;
    this.pending = { state, verifier, expiresAt: this.now() + PENDING_TTL_MS };
    return login.toString();
  }

  async startSignIn() {
    const url = this.buildSignIn();
    this.lastError = null;
    await this.openExternal(url);
    this.emit("changed", this.getState());
    return { started: true };
  }

  async handleCallback(url) {
    const pending = this.pending;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return this.fail("invalid_callback");
    }
    const act = parsed.searchParams.get("act");
    const state = parsed.searchParams.get("state");
    if (!pending || pending.expiresAt <= this.now()) {
      // A browser can deliver the same callback twice; after a completed sign-in that
      // duplicate must not replace the signed-in state with an error.
      if (!pending && this.session) return { ok: false, error: "no_pending_sign_in" };
      return this.fail("no_pending_sign_in");
    }
    if (!state || state !== pending.state) return this.fail("state_mismatch");
    if (!act) return this.fail(parsed.searchParams.get("error") || "missing_act");
    this.pending = null; // single use, whatever happens next
    const generation = this.generation;

    let body;
    try {
      const response = await this.fetchImpl(new URL("/api/exchange", this.config.portalUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          act,
          app_slug: this.config.appSlug,
          code_verifier: pending.verifier,
        }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
      body = await response.json().catch(() => null);
      if (!response.ok) return this.fail(body?.error || `exchange_http_${response.status}`);
    } catch (error) {
      return this.fail("exchange_unreachable", error);
    }
    if (generation !== this.generation) return { ok: false, error: "superseded" };
    if (!body || typeof body.email !== "string" || !body.email) {
      return this.fail("exchange_malformed");
    }
    // Fail closed: a missing appSlug counts as a mismatch (an act for another app).
    if (body.appSlug !== this.config.appSlug) {
      return this.fail("app_mismatch");
    }

    const session = {
      email: body.email,
      licenseKey: typeof body.licenseKey === "string" ? body.licenseKey : null,
      accountId: cleanAccountId(body.accountId),
      signedInAt: new Date(this.now()).toISOString(),
    };
    this.session = session;
    this.lastError = null;
    this.persist();
    const state_ = this.getState();
    this.emit("changed", state_);
    return { ok: true, state: state_ };
  }

  fail(code, error) {
    this.lastError = code;
    this.logger?.warn?.("Titanium sign-in failed", { code, error: error?.message }, "titanium");
    this.emit("changed", this.getState());
    return { ok: false, error: code };
  }

  /** Offline license status for the current session. Never throws. */
  licenseStatus() {
    if (!this.session) return { licensed: false, reason: "signed_out" };
    if (!this.session.licenseKey) return { licensed: false, reason: "no_license" };
    try {
      const payload = parseAndVerifyLicenseKey(this.session.licenseKey, {
        publicKey: this.config.publicKey,
        productId: this.config.keygenProductId,
        now: this.now,
      });
      return {
        licensed: true,
        license: {
          id: payload.license.id,
          expiry: payload.license.expiry ?? null,
          policyId: payload.policy?.id ?? null,
        },
      };
    } catch (error) {
      return { licensed: false, reason: error?.code || "invalid" };
    }
  }

  getState() {
    const status = this.licenseStatus();
    return {
      configured: this.isConfigured(),
      signedIn: Boolean(this.session),
      // The raw account id never reaches the renderer, only whether one is held.
      accountBound: Boolean(this.session?.accountId),
      email: this.session?.email ?? null,
      signedInAt: this.session?.signedInAt ?? null,
      licensed: status.licensed,
      license: status.license ?? null,
      reason: status.reason ?? null,
      pending: Boolean(this.pending && this.pending.expiresAt > this.now()),
      error: this.lastError,
    };
  }

  /** The Titanium account scope connectors are keyed on, or null when none is bound. */
  getAccountScope() {
    const accountId = this.session?.accountId;
    return accountId ? { accountId, authGeneration: this.generation } : null;
  }

  /** The verified license key for our servers (stt-api, search), or null. */
  getLicenseKey() {
    return this.licenseStatus().licensed ? this.session.licenseKey : null;
  }

  signOut() {
    this.generation += 1;
    this.session = null;
    this.pending = null;
    this.lastError = null;
    try {
      this.fs.rmSync(this.filePath, { force: true });
    } catch {}
    this.emit("changed", this.getState());
    return this.getState();
  }

  persist() {
    if (!this.session || !this.filePath) return;
    try {
      const data = this.encrypt(JSON.stringify(this.session));
      if (!data) return; // no OS encryption available: keep the session in memory only
      this.fs.writeFileSync(this.filePath, data, { mode: 0o600 });
    } catch (error) {
      this.logger?.warn?.("Could not save Titanium session", { error: error?.message }, "titanium");
    }
  }

  load() {
    try {
      if (!this.filePath || !this.fs.existsSync(this.filePath)) return this.getState();
      const raw = this.decrypt(this.fs.readFileSync(this.filePath));
      const session = JSON.parse(raw);
      if (typeof session?.email === "string" && session.email) {
        this.session = {
          email: session.email,
          licenseKey: typeof session.licenseKey === "string" ? session.licenseKey : null,
          accountId: cleanAccountId(session.accountId),
          signedInAt: session.signedInAt ?? null,
        };
      }
    } catch (error) {
      // Unreadable (another OS user, cleared keychain): start signed out.
      this.logger?.warn?.("Could not read Titanium session", { error: error?.message }, "titanium");
      this.session = null;
    }
    return this.getState();
  }
}

module.exports = { TitaniumSession, PENDING_TTL_MS };
