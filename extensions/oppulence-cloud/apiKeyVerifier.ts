import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import electron, { type App } from "electron";
import {
  ApiKeyVerifierSnapshotSchema,
  type ApiKeyScope,
  type ApiKeyVerifierSnapshot,
} from "../../src/config/openwhisprApi.ts";

const { net, safeStorage } = electron;
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

interface TokenStore {
  get(): string | null;
}

interface Logger {
  warn?(message: string, details?: Record<string, unknown>): void;
}

export class OppulenceAPIKeyVerifier {
  private readonly apiURL: string;
  private readonly cachePath: string;
  private readonly tokenStore: TokenStore;
  private readonly logger: Logger;
  private snapshot: ApiKeyVerifierSnapshot | null;
  private lastRefreshAttempt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(app: App, apiURL: string, tokenStore: TokenStore, logger: Logger) {
    this.apiURL = apiURL.replace(/\/$/, "");
    this.cachePath = path.join(app.getPath("userData"), "oppulence-api-key-verifiers.json");
    this.tokenStore = tokenStore;
    this.logger = logger;
    this.snapshot = this.readCache();
  }

  async authorize(secret: string, requiredScope: ApiKeyScope): Promise<boolean> {
    if (!secret.startsWith("opv_live_")) return false;
    await this.refreshIfDue();
    const snapshot = this.snapshot;
    if (!snapshot || Date.parse(snapshot.data.valid_until) <= Date.now()) return false;
    const digest = crypto.createHash("sha256").update(secret).digest("hex");
    return snapshot.data.verifiers.some(
      (verifier) =>
        verifier.digest.length === digest.length &&
        crypto.timingSafeEqual(Buffer.from(verifier.digest), Buffer.from(digest)) &&
        verifier.scopes.includes(requiredScope) &&
        (!verifier.expires_at || Date.parse(verifier.expires_at) > Date.now())
    );
  }

  private async refreshIfDue(): Promise<void> {
    if (Date.now() - this.lastRefreshAttempt < REFRESH_INTERVAL_MS) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.lastRefreshAttempt = Date.now();
    this.refreshPromise = this.refresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refresh(): Promise<void> {
    const token = this.tokenStore.get();
    if (!token) return;
    try {
      const response = await net.fetch(`${this.apiURL}/v1/voice/api-key-verifiers`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = ApiKeyVerifierSnapshotSchema.parse(await response.json());
      this.snapshot = snapshot;
      this.writeCache(snapshot);
    } catch (error) {
      this.logger.warn?.("Could not refresh Oppulence API key verifiers", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private readCache(): ApiKeyVerifierSnapshot | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const encrypted = Buffer.from(fs.readFileSync(this.cachePath, "utf8"), "base64");
      return ApiKeyVerifierSnapshotSchema.parse(JSON.parse(safeStorage.decryptString(encrypted)));
    } catch {
      return null;
    }
  }

  private writeCache(snapshot: ApiKeyVerifierSnapshot): void {
    if (!safeStorage.isEncryptionAvailable()) return;
    const encrypted = safeStorage.encryptString(JSON.stringify(snapshot)).toString("base64");
    fs.writeFileSync(this.cachePath, encrypted, { mode: 0o600 });
  }
}
