import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_MANIFEST_PATH = path.join(PROJECT_ROOT, "distributions", "openwhispr.json");
export const ALLOWED_EXTENSIONS = ["rowboat-export", "oppulence-cloud"] as const;

export const Identifier = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,63}$/);
export const ProductName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/);
export const AppId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$/)
  .refine((value) => value.includes(".") && !value.includes(".."), "Expected reverse-DNS ID");
export const ProtocolScheme = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9+.-]{1,31}$/);
const Slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const WindowsSafeDirectory = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/);
const AssetPath = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !path.isAbsolute(value), "Expected a project-relative asset path")
  .refine(
    (value) => !value.split(/[\\/]/).includes(".."),
    "Asset paths must not traverse outside the project"
  );
const HttpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Expected HTTP URL")
  .transform((value) => value.replace(/\/$/, ""));
const DevelopmentAPIURL = HttpUrl.refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))
  );
}, "Expected HTTPS or a loopback HTTP URL");
const DbusObjectPath = z
  .string()
  .trim()
  .refine(
    (value) =>
      value.startsWith("/") &&
      value.length > 1 &&
      value
        .slice(1)
        .split("/")
        .every((segment) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)),
    "Expected a D-Bus object path"
  );

export const DistributionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Identifier,
    productName: ProductName,
    companyName: z.string().trim().min(1),
    appId: AppId,
    protocolScheme: ProtocolScheme,
    executableName: Slug,
    runtimeNamespace: Slug,
    windowsSafeCacheDirectory: WindowsSafeDirectory,
    supportEmail: z.string().trim().email(),
    cloudDisplayName: z.string().trim().min(1),
    services: z.object({
      apiUrl: HttpUrl,
      authUrl: HttpUrl,
      oauthCallbackUrl: HttpUrl,
    }),
    updates: z.object({
      provider: z.literal("github"),
      owner: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_.-]+$/),
      repo: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_.-]+$/),
      private: z.boolean(),
    }),
    linux: z.object({
      desktopName: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9-]*\.desktop$/),
      appName: Slug,
      dbusServiceName: z
        .string()
        .trim()
        .regex(/^[A-Za-z_][A-Za-z0-9_.-]+$/),
      dbusObjectPath: DbusObjectPath,
      dbusInterface: z
        .string()
        .trim()
        .regex(/^[A-Za-z_][A-Za-z0-9_.-]+$/),
    }),
    assets: z.object({
      rendererLogo: AssetPath,
      rendererIcon: AssetPath,
      trayIcon: AssetPath,
      macIcon: AssetPath,
      windowsIcon: AssetPath,
      linuxIcon: AssetPath,
      /** Optional glyph for the onboarding shell; omit to keep the built-in SVG. */
      onboardingMark: AssetPath.nullish(),
      macAssetCatalog: z
        .object({
          file: AssetPath,
          iconName: z.string().trim().min(1),
        })
        .nullable(),
    }),
    signing: z.object({
      windowsAzure: z
        .object({
          endpoint: z.string().trim().url(),
          certificateProfileName: z.string().trim().min(1),
          codeSigningAccountName: z.string().trim().min(1),
          publisherName: z.string().trim().min(1),
        })
        .nullable(),
    }),
    capabilities: z.object({
      managedCloud: z.boolean(),
      rowboatExport: z.boolean(),
    }),
    extensions: z.array(z.enum(ALLOWED_EXTENSIONS)),
  })
  .superRefine((manifest, context) => {
    if (manifest.capabilities.rowboatExport !== manifest.extensions.includes("rowboat-export")) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", "rowboatExport"],
        message: "rowboatExport capability and extension must be enabled together",
      });
    }
  });

export type AppDistribution = z.infer<typeof DistributionSchema>;

export function validateDistribution(value: unknown): Readonly<AppDistribution> {
  const result = DistributionSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid distribution manifest: ${z.prettifyError(result.error)}`);
  }
  return Object.freeze(result.data);
}

export function resolveManifestPath(manifestPath?: string, cwd = PROJECT_ROOT): string {
  if (!manifestPath) return DEFAULT_MANIFEST_PATH;
  return path.isAbsolute(manifestPath) ? manifestPath : path.resolve(cwd, manifestPath);
}

export function loadDistribution(
  manifestPath?: string,
  cwd = PROJECT_ROOT
): Readonly<AppDistribution> {
  const resolvedPath = resolveManifestPath(manifestPath, cwd);
  return validateDistribution(JSON.parse(fs.readFileSync(resolvedPath, "utf8")));
}

export function loadSelectedDistribution(
  env: Record<string, string | undefined> = process.env,
  cwd = PROJECT_ROOT
): Readonly<AppDistribution> {
  const distribution = loadDistribution(
    env.DISTRIBUTION_MANIFEST || env.RELEASE_DISTRIBUTION_MANIFEST,
    cwd
  );
  if (!env.OPPULENCE_VOICE_API_URL) return distribution;
  if (distribution.id !== "oppulence-voice") {
    throw new Error("OPPULENCE_VOICE_API_URL may only override the Oppulence Voice distribution");
  }
  return Object.freeze({
    ...distribution,
    services: Object.freeze({
      ...distribution.services,
      apiUrl: DevelopmentAPIURL.parse(env.OPPULENCE_VOICE_API_URL),
    }),
  });
}
