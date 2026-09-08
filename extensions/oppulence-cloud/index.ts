import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import electron, { type App } from "electron";
import { z } from "zod";
import type { AppDistribution } from "../../src/config/distributionSchema";
import {
  OppulenceAuthStatusSchema,
  WorkOSLoginURLResponseSchema,
  WorkOSProviderSchema,
  WorkOSTokenBundleSchema,
  type OppulenceAuthStatus,
  type WorkOSTokenBundle,
} from "../../src/config/openwhisprApi.ts";

const { net, safeStorage, shell } = electron;
const require = createRequire(import.meta.url);
const REFRESH_SKEW_SECONDS = 5 * 60;
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;

interface TokenStore {
  get(): string | null;
  set(token: string): { success: boolean };
  clear(): { success: boolean };
}

interface ExtensionLogger {
  error?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
}

interface ExtensionContext {
  app: App;
  distribution: Readonly<AppDistribution>;
  logger: ExtensionLogger;
}

const StoredSessionSchema = z.object({
  bundle: WorkOSTokenBundleSchema,
});

type PendingLogin = {
  state: string;
  verifier: string;
  expiresAt: number;
};

export class OppulenceCloudExtension {
  readonly id = "oppulence-cloud";
  readonly rendererMethods = ["startLogin", "clearSession", "getAuthStatus"] as const;

  private readonly apiURL: string;
  private readonly callbackURL: URL;
  private readonly sessionPath: string;
  private readonly tokenStore: TokenStore;
  private readonly logger: ExtensionLogger;
  private server: http.Server | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private pending: PendingLogin | null = null;
  private bundle: WorkOSTokenBundle | null = null;

  constructor({ app, distribution, logger }: ExtensionContext) {
    this.apiURL = distribution.services.apiUrl.replace(/\/$/, "");
    this.callbackURL = new URL(distribution.services.oauthCallbackUrl);
    if (
      this.callbackURL.protocol !== "http:" ||
      this.callbackURL.hostname !== "127.0.0.1" ||
      !this.callbackURL.port
    ) {
      throw new Error("Oppulence OAuth callback must use an explicit 127.0.0.1 loopback port");
    }
    this.sessionPath = path.join(app.getPath("userData"), "oppulence-workos-session.bin");
    this.logger = logger;
    this.tokenStore = require("../../src/helpers/tokenStore.js") as TokenStore;
    this.bundle = this.readSession();
  }

  async start(): Promise<void> {
    await this.listen();
    await this.refreshIfNeeded();
  }

  private listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.server = http.createServer(
      (request, response) => void this.handleCallback(request, response)
    );
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server = null;
        reject(error);
      };
      this.server!.once("error", onError);
      this.server!.listen(Number(this.callbackURL.port), "127.0.0.1", () => {
        this.server!.off("error", onError);
        resolve();
      });
    });
  }

  private async handleCallback(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const requestURL = new URL(request.url || "/", this.callbackURL.origin);
    if (
      request.method !== "GET" ||
      request.headers.host !== this.callbackURL.host ||
      requestURL.pathname !== this.callbackURL.pathname
    ) {
      this.writeCallback(response, 404, "Not found");
      return;
    }
    const pending = this.pending;
    this.pending = null;
    const code = requestURL.searchParams.get("code");
    const state = requestURL.searchParams.get("state");
    if (!pending || Date.now() >= pending.expiresAt || !code || state !== pending.state) {
      this.writeCallback(response, 400, "The sign-in request is invalid or expired.");
      return;
    }
    try {
      const bundle = await this.postBundle("/v1/auth/workos/exchange", {
        code,
        codeVerifier: pending.verifier,
      });
      this.commit(bundle);
      this.writeCallback(
        response,
        200,
        "Oppulence Voice sign-in complete. You can close this tab."
      );
    } catch (error) {
      this.logger.error?.("Oppulence WorkOS exchange failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.writeCallback(
        response,
        502,
        "Sign-in could not be completed. Return to Oppulence Voice and try again."
      );
    }
  }

  private writeCallback(response: http.ServerResponse, status: number, message: string): void {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Oppulence Voice</title><p>${message}</p>`
    );
  }

  private async startLogin(payload: unknown): Promise<OppulenceAuthStatus> {
    const provider = z
      .object({ provider: WorkOSProviderSchema.default("authkit") })
      .parse(payload ?? {}).provider;
    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    this.pending = { state, verifier, expiresAt: Date.now() + CALLBACK_TIMEOUT_MS };

    const query = new URLSearchParams({
      redirect_uri: this.callbackURL.toString(),
      state,
      code_challenge: challenge,
      provider,
    });
    const response = await net.fetch(`${this.apiURL}/v1/auth/workos/login-url?${query}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      this.pending = null;
      throw new Error(`Oppulence sign-in returned HTTP ${response.status}`);
    }
    const login = WorkOSLoginURLResponseSchema.parse(await response.json());
    await shell.openExternal(login.url);
    return this.status();
  }

  private async refreshIfNeeded(): Promise<void> {
    const bundle = this.bundle;
    if (!bundle) return;
    if (bundle.expires_at > Math.floor(Date.now() / 1_000) + REFRESH_SKEW_SECONDS) {
      this.tokenStore.set(bundle.access_token);
      this.scheduleRefresh(bundle);
      return;
    }
    if (!bundle.refresh_token) {
      this.clearSession();
      return;
    }
    try {
      this.commit(
        await this.postBundle("/v1/auth/workos/refresh", {
          refreshToken: bundle.refresh_token,
        })
      );
    } catch (error) {
      this.logger.warn?.("Oppulence WorkOS refresh failed closed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.clearSession();
    }
  }

  private async postBundle(pathname: string, body: unknown): Promise<WorkOSTokenBundle> {
    const response = await net.fetch(`${this.apiURL}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Oppulence authentication returned HTTP ${response.status}`);
    return WorkOSTokenBundleSchema.parse(await response.json());
  }

  private commit(bundle: WorkOSTokenBundle): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system");
    }
    const stored = safeStorage
      .encryptString(JSON.stringify({ bundle: WorkOSTokenBundleSchema.parse(bundle) }))
      .toString("base64");
    fs.writeFileSync(this.sessionPath, stored, { mode: 0o600 });
    this.bundle = bundle;
    if (!this.tokenStore.set(bundle.access_token).success) {
      throw new Error("Could not persist the WorkOS access token");
    }
    this.scheduleRefresh(bundle);
  }

  private readSession(): WorkOSTokenBundle | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const encrypted = Buffer.from(fs.readFileSync(this.sessionPath, "utf8"), "base64");
      return StoredSessionSchema.parse(JSON.parse(safeStorage.decryptString(encrypted))).bundle;
    } catch {
      return null;
    }
  }

  private scheduleRefresh(bundle: WorkOSTokenBundle): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(1_000, (bundle.expires_at - REFRESH_SKEW_SECONDS) * 1_000 - Date.now());
    this.refreshTimer = setTimeout(() => void this.refreshIfNeeded(), delay);
    this.refreshTimer.unref();
  }

  private clearSession(): OppulenceAuthStatus {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.pending = null;
    this.bundle = null;
    try {
      fs.rmSync(this.sessionPath, { force: true });
    } finally {
      this.tokenStore.clear();
    }
    return this.status();
  }

  private status(): OppulenceAuthStatus {
    return OppulenceAuthStatusSchema.parse({
      signedIn: Boolean(this.bundle && this.tokenStore.get()),
      expiresAt: this.bundle?.expires_at ?? null,
    });
  }

  async invoke(method: string, payload: unknown): Promise<unknown> {
    if (method === "startLogin") return this.startLogin(payload);
    if (method === "clearSession") return this.clearSession();
    if (method === "getAuthStatus") return this.status();
    throw new Error("Unsupported Oppulence cloud extension method");
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }
}

export async function create(context: ExtensionContext): Promise<OppulenceCloudExtension> {
  const extension = new OppulenceCloudExtension(context);
  await extension.start();
  return extension;
}
