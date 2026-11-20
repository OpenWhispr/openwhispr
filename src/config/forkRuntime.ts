// Fork-owned configuration seam (renderer). Mirrors forkConfig.js (main process).
// Empty API_URL or AUTH_URL means the hosted cloud is disabled.
import fork from "./fork.config.json" with { type: "json" };
import { isTitaniumCloudEnabled } from "../helpers/titanium/titaniumOnboardingPolicy.js";

// Vite inlines import.meta.env in the renderer; outside Vite (node tests, main-process
// ESM entries) fall back to process.env.
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const env = (viteEnv ?? (typeof process !== "undefined" ? process.env : {})) as Record<
  string,
  string | undefined
>;

const strip = (value: string) => value.replace(/\/+$/, "");

export const API_URL = strip(env.VITE_OPENWHISPR_API_URL || fork.API_URL || "");
export const AUTH_URL = strip(env.VITE_AUTH_URL || fork.AUTH_URL || "");
export const ADMIN_URL = strip(env.VITE_ADMIN_URL || fork.ADMIN_URL || "");
export const SITE_URL = strip(env.VITE_SITE_URL || fork.SITE_URL || "");
export const SERVICES_URL = strip(env.VITE_SERVICES_URL || fork.SERVICES_URL || "");
export const DOCS_URL = strip(env.VITE_DOCS_URL || fork.DOCS_URL || "");
export const SUPPORT_EMAIL = env.VITE_SUPPORT_EMAIL || fork.SUPPORT_EMAIL || "";
export const SHARE_VIEWER_URL = strip(env.VITE_SHARE_VIEWER_URL || fork.SHARE_VIEWER_URL || "");
export const MCP_URL = env.VITE_MCP_URL || fork.MCP_URL || "";
export const BRAND_NAME = fork.BRAND_NAME;
export const DEFAULT_STT = fork.DEFAULT_STT;
export const TITANIUM = fork.TITANIUM;
export const CLOUD_ENABLED = Boolean(API_URL && AUTH_URL);
// Titanium portal sign-in is available (the fork has no hosted OpenWhispr cloud).
export const TITANIUM_ENABLED = isTitaniumCloudEnabled(TITANIUM);
export const REPO_URL = strip(fork.REPO_URL || "");
export const COMMUNITY_URL = strip(fork.COMMUNITY_URL || "");
export const URL_SCHEME = fork.URL_SCHEME;
